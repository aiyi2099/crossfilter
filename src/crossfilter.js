exports.crossfilter = crossfilter;

function crossfilter() {
  var crossfilter = {
    add: add,
    remove: removeData,
    dimension: dimension,
    groupAll: groupAll,
    size: size,
    all: all,
    onChange: onChange,
    isElementFiltered: isElementFiltered,
  };

  var data = [], // the records
      n = 0, // the number of records; data.length
      filters, // 1 is filtered out
      filterListeners = [], // when the filters change
      dataListeners = [], // when data is added
      removeDataListeners = [], // when data is removed
      callbacks = [];

  filters = new crossfilter_bitarray(0);

  // Adds the specified new records to this crossfilter.
  function add(newData) {
    var n0 = n,
        n1 = newData.length;

    // If there's actually new data to add…
    // Merge the new data into the existing data.
    // Lengthen the filter bitset to handle the new records.
    // Notify listeners (dimensions and groups) that new data is available.
    if (n1) {
      data = data.concat(newData);
      filters.lengthen(n += n1);
      dataListeners.forEach(function(l) { l(newData, n0, n1); });
      triggerOnChange('dataAdded');
    }

    return crossfilter;
  }

  // Removes all records that match the current filters.
  function removeData() {
    var newIndex = crossfilter_index(n, n),
        removed = [];
    for (var i = 0, j = 0; i < n; ++i) {
      if (!filters.zero(i)) newIndex[i] = j++;
      else removed.push(i);
    }

    // Remove all matching records from groups.
    filterListeners.forEach(function(l) { l(-1, -1, [], removed, true); });

    // Update indexes.
    removeDataListeners.forEach(function(l) { l(newIndex); });

    // Remove old filters and data by overwriting.
    for (var i = 0, j = 0; i < n; ++i) {
      if (!filters.zero(i)) {
        if (i !== j) filters.copy(j, i), data[j] = data[i];
        ++j;
      }
    }

    data.length = n = j;
    filters.truncate(j);
    triggerOnChange('dataRemoved');
  }

  // Return true if the data element at index i is filtered IN.
  // Optionally, ignore the filters of any dimensions in the ignore_dimensions list.
  function isElementFiltered(i, ignore_dimensions) {
      var n,
          d,
          dimension,
          mask = Array(filters.subarrays);
      for (n = 0; n < filters.subarrays; n++) mask[n] = ~0;
      if (ignore_dimensions)
          for (d = 0; d < ignore_dimensions.length; d++) {
              dimension = ignore_dimensions[d];
              mask[dimension._offset] &= dimension._zero;
          }
      return filters.zeroExceptMask(i,mask);
  }  
    
  // Adds a new dimension with the specified value accessor function.
  function dimension(value, iterable) {
    var dimension = {
      filter: filter,
      filterExact: filterExact,
      filterRange: filterRange,
      filterFunction: filterFunction,
      filterAll: filterAll,
      top: top,
      bottom: bottom,
      group: group,
      groupAll: groupAll,
      dispose: dispose,
      remove: dispose // for backwards-compatibility
    };

    var one, // lowest unset bit as mask, e.g., 00001000
        zero, // inverted one, e.g., 11110111
        offset, // offset into the filters arrays
        values, // sorted, cached array
        index, // value rank ↦ object id
        oldValues, // temporary array storing previously-added values
        oldIndex, // temporary array storing previously-added index
        newValues, // temporary array storing newly-added values
        newIndex, // temporary array storing newly-added index
        iterablesIndexCount,
        newIterablesIndexCount,
        iterablesIndexFilterStatus,
        newIterablesIndexFilterStatus,
        oldIterablesIndexFilterStatus,
        iterablesEmptyRows,
        sort = quicksort_by(function(i) { return newValues[i]; }),
        refilter = crossfilter_filterAll, // for recomputing filter
        refilterFunction, // the custom filter function in use
        indexListeners = [], // when data is added
        dimensionGroups = [],
        lo0 = 0,
        hi0 = 0,
        t = 0;

    // Updating a dimension is a two-stage process. First, we must update the
    // associated filters for the newly-added records. Once all dimensions have
    // updated their filters, the groups are notified to update.
    dataListeners.unshift(preAdd);
    dataListeners.push(postAdd);

    removeDataListeners.push(removeData);

    // Add a new dimension in the filter bitmap and store the offset and bitmask.
    var tmp = filters.add();
    offset = tmp.offset;
    one = tmp.one;
    zero = ~one;
      
    // Expose the dimension mask for internal use
    dimension._offset = offset;
    dimension._one = one;
    dimension._zero = zero;

    preAdd(data, 0, n);
    postAdd(data, 0, n);

    // Incorporates the specified new records into this dimension.
    // This function is responsible for updating filters, values, and index.
    function preAdd(newData, n0, n1) {

      if (iterable){
        // Count all the values
        t = 0;
        j = 0;
        k = [];

        for (i = 0; i < newData.length; i++) {
          for(j = 0, k = value(newData[i]); j < k.length; j++) {
            t++;
          }
        }

        newValues = [];
        newIterablesIndexCount = crossfilter_range(newData.length);
        newIterablesIndexFilterStatus = crossfilter_index(t,1);
        iterablesEmptyRows = [];
        var unsortedIndex = crossfilter_range(t);

        for (l = 0, i = 0; i < newData.length; i++) {
          k = value(newData[i])
          //
          if(!k.length){
            newIterablesIndexCount[i] = 0;
            iterablesEmptyRows.push(i);
            continue;
          }
          newIterablesIndexCount[i] = k.length
          for (j = 0; j < k.length; j++) {
            newValues.push(k[j]);
            unsortedIndex[l] = i;
            l++;
          }
        }

        // Create the Sort map used to sort both the values and the valueToData indices
        var sortMap = sort(crossfilter_range(t), 0, t);

        // Use the sortMap to sort the newValues
        newValues = permute(newValues, sortMap);


        // Use the sortMap to sort the unsortedIndex map
        // newIndex should be a map of sortedValue -> crossfilterData
        newIndex = permute(unsortedIndex, sortMap)

      } else{
        // Permute new values into natural order using a standard sorted index.
        newValues = newData.map(value);
        newIndex = sort(crossfilter_range(n1), 0, n1);
        newValues = permute(newValues, newIndex);
      }
      
      if(iterable) {
        n1 = t;
      }

      // Bisect newValues to determine which new records are selected.
      var bounds = refilter(newValues), lo1 = bounds[0], hi1 = bounds[1];
      if (refilterFunction) {
        for (i = 0; i < n1; ++i) {
          if (!refilterFunction(newValues[i], i)) {
            filters[offset][newIndex[i] + n0] |= one;
            if(iterable) newIterablesIndexFilterStatus[i] = 1;
          }
        }
      } else {
        for (i = 0; i < lo1; ++i) { 
          filters[offset][newIndex[i] + n0] |= one;
          if(iterable) newIterablesIndexFilterStatus[i] = 1;
        }
        for (i = hi1; i < n1; ++i) {
          filters[offset][newIndex[i] + n0] |= one;
          if(iterable) newIterablesIndexFilterStatus[i] = 1;
        }
      }

      // If this dimension previously had no data, then we don't need to do the
      // more expensive merge operation; use the new values and index as-is.
      if (!n0) {
        values = newValues;
        index = newIndex;
        iterablesIndexCount = newIterablesIndexCount;
        iterablesIndexFilterStatus = newIterablesIndexFilterStatus;
        lo0 = lo1;
        hi0 = hi1;
        return;
      }



      oldValues = values,
        oldIndex = index,
        oldIterablesIndexFilterStatus = iterablesIndexFilterStatus
        i0 = 0,
        i1 = 0;

      if(iterable){
        old_n0 = n0
        n0 = oldValues.length;
        n1 = t
      }

      // Otherwise, create new arrays into which to merge new and old.
      values = iterable ? new Array(n0 + n1) : new Array(n);
      index = iterable ? new Array(n0 + n1) : crossfilter_index(n, n); 
      if(iterable) iterablesIndexFilterStatus = crossfilter_index(n0 + n1, 1); 
      
      // Concatenate the newIterablesIndexCount onto the old one.
      if(iterable) {
        var oldiiclength = iterablesIndexCount.length;
        iterablesIndexCount = crossfilter_arrayLengthen(iterablesIndexCount, n);
        for(var j=0; j+oldiiclength < n; j++) {
          iterablesIndexCount[j+oldiiclength] = newIterablesIndexCount[j];
        }
      }

      // Merge the old and new sorted values, and old and new index.
      for (i = 0; i0 < n0 && i1 < n1; ++i) {
        if (oldValues[i0] < newValues[i1]) {
          values[i] = oldValues[i0];
          if(iterable) iterablesIndexFilterStatus[i] = oldIterablesIndexFilterStatus[i0];
          index[i] = oldIndex[i0++];
        } else {
          values[i] = newValues[i1];
          if(iterable) iterablesIndexFilterStatus[i] = oldIterablesIndexFilterStatus[i1];
          index[i] = newIndex[i1++] + (iterable ? old_n0 : n0);
        }
      }

      // Add any remaining old values.
      for (; i0 < n0; ++i0, ++i) {
        values[i] = oldValues[i0];
        if(iterable) iterablesIndexFilterStatus[i] = oldIterablesIndexFilterStatus[i0];
        index[i] = oldIndex[i0];
      }

      // Add any remaining new values.
      for (; i1 < n1; ++i1, ++i) {
        values[i] = newValues[i1];
        if(iterable) iterablesIndexFilterStatus[i] = oldIterablesIndexFilterStatus[i1];
        index[i] = newIndex[i1] + (iterable ? old_n0 : n0);
      }

      // Bisect again to recompute lo0 and hi0.
      bounds = refilter(values), lo0 = bounds[0], hi0 = bounds[1];
    }

    // When all filters have updated, notify index listeners of the new values.
    function postAdd(newData, n0, n1) {
      indexListeners.forEach(function(l) { l(newValues, newIndex, n0, n1); });
      newValues = newIndex = null;
    }

    function removeData(reIndex) {
      for (var i = 0, j = 0, k; i < n; ++i) {
        if (!filters.zero(k = index[i])) {
          if (i !== j) values[j] = values[i];
          index[j] = reIndex[k];
          ++j;
        }
      }
      values.length = j;
      while (j < n) index[j++] = 0;

      // Bisect again to recompute lo0 and hi0.
      var bounds = refilter(values);
      lo0 = bounds[0], hi0 = bounds[1];
    }

    // Updates the selected values based on the specified bounds [lo, hi].
    // This implementation is used by all the public filter methods.
    function filterIndexBounds(bounds) {

      var lo1 = bounds[0],
          hi1 = bounds[1];

      if (refilterFunction) {
        refilterFunction = null;
        filterIndexFunction(function(d, i) { return lo1 <= i && i < hi1; }, bounds[0] === 0 && bounds[1] === index.length);
        lo0 = lo1;
        hi0 = hi1;
        return dimension;
      }

      var i,
          j,
          k,
          added = [],
          removed = [],
          valueIndexAdded = [],
          valueIndexRemoved = [];
          
          
      // Fast incremental update based on previous lo index.
      if (lo1 < lo0) {
        for (i = lo1, j = Math.min(lo0, hi1); i < j; ++i) {
          added.push(index[i]);
          valueIndexAdded.push(i);
        }
      } else if (lo1 > lo0) {
        for (i = lo0, j = Math.min(lo1, hi0); i < j; ++i) {
          removed.push(index[i]);
          valueIndexRemoved.push(i);
        }
      }

      // Fast incremental update based on previous hi index.
      if (hi1 > hi0) {
        for (i = Math.max(lo1, hi0), j = hi1; i < j; ++i) {
          added.push(index[i]);
          valueIndexAdded.push(i);
        }
      } else if (hi1 < hi0) {
        for (i = Math.max(lo0, hi1), j = hi0; i < j; ++i) {
          removed.push(index[i]);
          valueIndexRemoved.push(i);
        }
      }

      if(!iterable) {
        // Flip filters normally.
        
        for(i=0; i<added.length; i++) {
          filters[offset][added[i]] ^= one;
        }
        
        for(i=0; i<removed.length; i++) {
          filters[offset][removed[i]] ^= one;
        }
        
      } else {
        // For iterables, we need to figure out if the row has been completely removed vs partially included
        // Only count a row as added if it is not already being aggregated. Only count a row
        // as removed if the last element being aggregated is removed.

        var newAdded = [];
        var newRemoved = [];
        for (i = 0; i < added.length; i++) {
          iterablesIndexCount[added[i]]++
          iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
          if(iterablesIndexCount[added[i]] === 1) {
            filters[offset][added[i]] ^= one;
            newAdded.push(added[i]);
          }
        }
        for (i = 0; i < removed.length; i++) {
          iterablesIndexCount[removed[i]]--
          iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
          if(iterablesIndexCount[removed[i]] === 0) {
            filters[offset][removed[i]] ^= one;
            newRemoved.push(removed[i]);
          }
        }

        added = newAdded;
        removed = newRemoved;

        // Now handle empty rows.
        if(bounds[0] === 0 && bounds[1] === index.length) {
          for(i = 0; i < iterablesEmptyRows.length; i++) {
            if((filters[offset][k = iterablesEmptyRows[i]] & one)) {
              // Was not in the filter, so set the filter and add
              filters[offset][k] ^= one;
              added.push(k);
            }
          }
        } else {
          // filter in place - remove empty rows if necessary
          for(i = 0; i < iterablesEmptyRows.length; i++) {
            if(!(filters[offset][k = iterablesEmptyRows[i]] & one)) {
              // Was in the filter, so set the filter and remove
              filters[offset][k] ^= one;
              removed.push(k);
            }
          }
        }
      }

      lo0 = lo1;
      hi0 = hi1;
      filterListeners.forEach(function(l) { l(one, offset, added, removed); });
      triggerOnChange('filtered');
      return dimension;
    }

    // Filters this dimension using the specified range, value, or null.
    // If the range is null, this is equivalent to filterAll.
    // If the range is an array, this is equivalent to filterRange.
    // Otherwise, this is equivalent to filterExact.
    function filter(range) {
      return range == null
          ? filterAll() : Array.isArray(range)
          ? filterRange(range) : typeof range === "function"
          ? filterFunction(range)
          : filterExact(range);
    }

    // Filters this dimension to select the exact value.
    function filterExact(value) {
      return filterIndexBounds((refilter = crossfilter_filterExact(bisect, value))(values));
    }

    // Filters this dimension to select the specified range [lo, hi].
    // The lower bound is inclusive, and the upper bound is exclusive.
    function filterRange(range) {
      return filterIndexBounds((refilter = crossfilter_filterRange(bisect, range))(values));
    }

    // Clears any filters on this dimension.
    function filterAll() {
      return filterIndexBounds((refilter = crossfilter_filterAll)(values));
    }

    // Filters this dimension using an arbitrary function.
    function filterFunction(f) {
      refilter = crossfilter_filterAll;

      filterIndexFunction(refilterFunction = f, false);

      lo0 = 0;
      hi0 = n;

      return dimension;
    }

    function filterIndexFunction(f, filterAll) {
      var i,
          k,
          x,
          added = [],
          removed = [],
          valueIndexAdded = [],
          valueIndexRemoved = [],
          indexLength = index.length;

      if(!iterable) {
        for (i = 0; i < indexLength; ++i) {
          if (!(filters[offset][k = index[i]] & one) ^ !!(x = f(values[i], i))) {
            if (x) added.push(k);
            else removed.push(k);
          }
        }
      }
      
      if(iterable) {
        for(i=0; i < indexLength; ++i) {
          if(f(values[i], i)) {
            added.push(index[i]);
            valueIndexAdded.push(i);
          } else {
            removed.push(index[i]);
            valueIndexRemoved.push(i);
          }
        }
      }
      
      if(!iterable) {
        for(i=0; i<added.length; i++) {
          if(filters[offset][added[i]] & one) filters[offset][added[i]] &= zero;
        }
        
        for(i=0; i<removed.length; i++) {
          if(!(filters[offset][removed[i]] & one)) filters[offset][removed[i]] |= one;
        }
      } else {
        
        var newAdded = [];
        var newRemoved = [];
        for (i = 0; i < added.length; i++) {
          // First check this particular value needs to be added
          if(iterablesIndexFilterStatus[valueIndexAdded[i]] === 1) {  
            iterablesIndexCount[added[i]]++
            iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
            if(iterablesIndexCount[added[i]] === 1) {
              filters[offset][added[i]] ^= one;
              newAdded.push(added[i]);
            }
          }
        }
        for (i = 0; i < removed.length; i++) {
          // First check this particular value needs to be removed
          if(iterablesIndexFilterStatus[valueIndexRemoved[i]] === 0) {  
            iterablesIndexCount[removed[i]]--
            iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
            if(iterablesIndexCount[removed[i]] === 0) {
              filters[offset][removed[i]] ^= one;
              newRemoved.push(removed[i]);
            }
          }
        }

        added = newAdded;
        removed = newRemoved;
        
        // Now handle empty rows.
        if(filterAll) {
          for(i = 0; i < iterablesEmptyRows.length; i++) {
            if((filters[offset][k = iterablesEmptyRows[i]] & one)) {
              // Was not in the filter, so set the filter and add
              filters[offset][k] ^= one;
              added.push(k);
            }
          }
        } else {
          // filter in place - remove empty rows if necessary
          for(i = 0; i < iterablesEmptyRows.length; i++) {
            if(!(filters[offset][k = iterablesEmptyRows[i]] & one)) {
              // Was in the filter, so set the filter and remove
              filters[offset][k] ^= one;
              removed.push(k);
            }
          }
        }
      }

      filterListeners.forEach(function(l) { l(one, offset, added, removed); });
      triggerOnChange('filtered');
    }

    // Returns the top K selected records based on this dimension's order.
    // Note: observes this dimension's filter, unlike group and groupAll.
    function top(k) {
      var array = [],
          i = hi0,
          j;

      while (--i >= lo0 && k > 0) {
        if (filters.zero(j = index[i])) {
          array.push(data[j]);
          --k;
        }
      }

      if(iterable){
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          // Add empty rows at the end
          if(filters.zero(j = iterablesEmptyRows[i])) {
            array.push(data[j]);
            --k;
          }
        }
      }

      return array;
    }

    // Returns the bottom K selected records based on this dimension's order.
    // Note: observes this dimension's filter, unlike group and groupAll.
    function bottom(k) {
      var array = [],
          i,
          j;

      if(iterable) {
        // Add empty rows at the top
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filters.zero(j = iterablesEmptyRows[i])) {
            array.push(data[j]);
            --k;
          }
        }
      }

      i = lo0;

      while (i < hi0 && k > 0) {
        if (filters.zero(j = index[i])) {
          array.push(data[j]);
          --k;
        }
        i++;
      }

      return array;
    }

    // Adds a new group to this dimension, using the specified key function.
    function group(key) {
      var group = {
        top: top,
        all: all,
        reduce: reduce,
        reduceCount: reduceCount,
        reduceSum: reduceSum,
        order: order,
        orderNatural: orderNatural,
        size: size,
        dispose: dispose,
        remove: dispose // for backwards-compatibility
      };

      // Ensure that this group will be removed when the dimension is removed.
      dimensionGroups.push(group);

      var groups, // array of {key, value}
          groupIndex, // object id ↦ group id
          groupWidth = 8,
          groupCapacity = crossfilter_capacity(groupWidth),
          k = 0, // cardinality
          select,
          heap,
          reduceAdd,
          reduceRemove,
          reduceInitial,
          update = crossfilter_null,
          reset = crossfilter_null,
          resetNeeded = true,
          groupAll = key === crossfilter_null;

      if (arguments.length < 1) key = crossfilter_identity;

      // The group listens to the crossfilter for when any dimension changes, so
      // that it can update the associated reduce values. It must also listen to
      // the parent dimension for when data is added, and compute new keys.
      filterListeners.push(update);
      indexListeners.push(add);
      removeDataListeners.push(removeData);

      // Incorporate any existing data into the grouping.
      add(values, index, 0, n);

      // Incorporates the specified new values into this group.
      // This function is responsible for updating groups and groupIndex.
      function add(newValues, newIndex, n0, n1) {

        if(iterable) {
          n0old = n0
          n0 = values.length - newValues.length
          n1 = newValues.length;
        }

        var oldGroups = groups,
            reIndex = iterable ? [] : crossfilter_index(k, groupCapacity),
            add = reduceAdd,
            remove = reduceRemove,
            initial = reduceInitial,
            k0 = k, // old cardinality
            i0 = 0, // index of old group
            i1 = 0, // index of new record
            j, // object id
            g0, // old group
            x0, // old key
            x1, // new key
            g, // group to add
            x; // key of group to add

        // If a reset is needed, we don't need to update the reduce values.
        if (resetNeeded) add = initial = crossfilter_null;
        if (resetNeeded) remove = initial = crossfilter_null;

        // Reset the new groups (k is a lower bound).
        // Also, make sure that groupIndex exists and is long enough.
        groups = new Array(k), k = 0;
        if(iterable){
          groupIndex = k0 > 1 ? groupIndex : [];
        }
        else{
          groupIndex = k0 > 1 ? crossfilter_arrayLengthen(groupIndex, n) : crossfilter_index(n, groupCapacity);
        }


        // Get the first old key (x0 of g0), if it exists.
        if (k0) x0 = (g0 = oldGroups[0]).key;

        // Find the first new key (x1), skipping NaN keys.
        while (i1 < n1 && !((x1 = key(newValues[i1])) >= x1)) ++i1;

        // While new keys remain…
        while (i1 < n1) {

          // Determine the lesser of the two current keys; new and old.
          // If there are no old keys remaining, then always add the new key.
          if (g0 && x0 <= x1) {
            g = g0, x = x0;

            // Record the new index of the old group.
            reIndex[i0] = k;

            // Retrieve the next old key.
            if (g0 = oldGroups[++i0]) x0 = g0.key;
          } else {
            g = {key: x1, value: initial()}, x = x1;
          }

          // Add the lesser group.
          groups[k] = g;

          // Add any selected records belonging to the added group, while
          // advancing the new key and populating the associated group index.

          while (x1 <= x) {
            j = newIndex[i1] + (iterable ? n0old : n0)


            if(iterable){
              if(groupIndex[j]){
                groupIndex[j].push(k)
              }
              else{
                groupIndex[j] = [k]
              }
            }
            else{
              groupIndex[j] = k;
            }

            // Always add new values to groups. Only remove when not in filter.
            // This gives groups full information on data life-cycle.
            g.value = add(g.value, data[j], true);
            if (!filters.zeroExcept(j, offset, zero)) g.value = remove(g.value, data[j], false);
            if (++i1 >= n1) break;
            x1 = key(newValues[i1]);
          }

          groupIncrement();
        }

        // Add any remaining old groups that were greater th1an all new keys.
        // No incremental reduce is needed; these groups have no new records.
        // Also record the new index of the old group.
        while (i0 < k0) {
          groups[reIndex[i0] = k] = oldGroups[i0++];
          groupIncrement();
        }


        // Fill in gaps with empty arrays where there may have been rows with empty iterables
        if(iterable){
          for (i = 0; i < n; i++) {
            if(!groupIndex[i]){
              groupIndex[i] = []
            }
          }
        }

        // If we added any new groups before any old groups,
        // update the group index of all the old records.
        if(k > i0){
          if(iterable){
            groupIndex = permute(groupIndex, reIndex, true)
          }
          else{
            for (i0 = 0; i0 < n0; ++i0) {
              groupIndex[i0] = reIndex[groupIndex[i0]];
            }
          }
        }

        // Modify the update and reset behavior based on the cardinality.
        // If the cardinality is less than or equal to one, then the groupIndex
        // is not needed. If the cardinality is zero, then there are no records
        // and therefore no groups to update or reset. Note that we also must
        // change the registered listener to point to the new method.
        j = filterListeners.indexOf(update);
        if (k > 1) {
          update = updateMany;
          reset = resetMany;
        } else {
          if (!k && groupAll) {
            k = 1;
            groups = [{key: null, value: initial()}];
          }
          if (k === 1) {
            update = updateOne;
            reset = resetOne;
          } else {
            update = crossfilter_null;
            reset = crossfilter_null;
          }
          groupIndex = null;
        }
        filterListeners[j] = update;

        // Count the number of added groups,
        // and widen the group index as needed.
        function groupIncrement() {
          if(iterable){
            k++
            return
          }
          if (++k === groupCapacity) {
            reIndex = crossfilter_arrayWiden(reIndex, groupWidth <<= 1);
            groupIndex = crossfilter_arrayWiden(groupIndex, groupWidth);
            groupCapacity = crossfilter_capacity(groupWidth);
          }
        }
      }

      function removeData() {
        if (k > 1) {
          var oldK = k,
              oldGroups = groups,
              seenGroups = crossfilter_index(oldK, oldK);

          // Filter out non-matches by copying matching group index entries to
          // the beginning of the array.
          for (var i = 0, j = 0; i < n; ++i) {
            if (!filters.zero(i)) {
              seenGroups[groupIndex[j] = groupIndex[i]] = 1;
              ++j;
            }
          }

          // Reassemble groups including only those groups that were referred
          // to by matching group index entries.  Note the new group index in
          // seenGroups.
          groups = [], k = 0;
          for (i = 0; i < oldK; ++i) {
            if (seenGroups[i]) {
              seenGroups[i] = k++;
              groups.push(oldGroups[i]);
            }
          }

          if (k > 1) {
            // Reindex the group index using seenGroups to find the new index.
            for (var i = 0; i < j; ++i) groupIndex[i] = seenGroups[groupIndex[i]];
          } else {
            groupIndex = null;
          }
          filterListeners[filterListeners.indexOf(update)] = k > 1
              ? (reset = resetMany, update = updateMany)
              : k === 1 ? (reset = resetOne, update = updateOne)
              : reset = update = crossfilter_null;
        } else if (k === 1) {
          if (groupAll) return;
          for (var i = 0; i < n; ++i) if (!filters.zero(i)) return;
          groups = [], k = 0;
          filterListeners[filterListeners.indexOf(update)] =
          update = reset = crossfilter_null;
        }
      }

      // Reduces the specified selected or deselected records.
      // This function is only used when the cardinality is greater than 1.
      // notFilter indicates a crossfilter.add/remove operation.
      function updateMany(filterOne, filterOffset, added, removed, notFilter) {
        
        if ((filterOne === one && filterOffset === offset) || resetNeeded) return;

        var i,
            j,
            k,
            n,
            g;

        if(iterable){
          // Add the added values.
          for (i = 0, n = added.length; i < n; ++i) {
            if (filters.zeroExcept(k = added[i], offset, zero)) {
              for (j = 0; j < groupIndex[k].length; j++) {
                g = groups[groupIndex[k][j]];
                g.value = reduceAdd(g.value, data[k], false, j);
              }
            }
          }

          // Remove the removed values.
          for (i = 0, n = removed.length; i < n; ++i) {
            if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
              for (j = 0; j < groupIndex[k].length; j++) {
                g = groups[groupIndex[k][j]];
                g.value = reduceRemove(g.value, data[k], notFilter, j);
              }
            }
          }
          return;
        }

        // Add the added values.
        for (i = 0, n = added.length; i < n; ++i) {
          if (filters.zeroExcept(k = added[i], offset, zero)) {
            g = groups[groupIndex[k]];
            g.value = reduceAdd(g.value, data[k], false);
          }
        }

        // Remove the removed values.
        for (i = 0, n = removed.length; i < n; ++i) {
          if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
            g = groups[groupIndex[k]];
            g.value = reduceRemove(g.value, data[k], notFilter);
          }
        }
      }

      // Reduces the specified selected or deselected records.
      // This function is only used when the cardinality is 1.
      // notFilter indicates a crossfilter.add/remove operation.
      function updateOne(filterOne, filterOffset, added, removed, notFilter) {
        if ((filterOne === one && filterOffset === offset) || resetNeeded) return;

        var i,
            k,
            n,
            g = groups[0];

        // Add the added values.
        for (i = 0, n = added.length; i < n; ++i) {
          if (filters.zeroExcept(k = added[i], offset, zero)) {
            g.value = reduceAdd(g.value, data[k], false);
          }
        }

        // Remove the removed values.
        for (i = 0, n = removed.length; i < n; ++i) {
          if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
            g.value = reduceRemove(g.value, data[k], notFilter);
          }
        }
      }

      // Recomputes the group reduce values from scratch.
      // This function is only used when the cardinality is greater than 1.
      function resetMany() {
        var i,
            j,
            g;

        // Reset all group values.
        for (i = 0; i < k; ++i) {
          groups[i].value = reduceInitial();
        }

        // We add all records and then remove filtered records so that reducers
        // can build an 'unfiltered' view even if there are already filters in
        // place on other dimensions.
        if(iterable){
          for (i = 0; i < n; ++i) {
            for (j = 0; j < groupIndex[i].length; j++) {
              g = groups[groupIndex[i][j]];
              g.value = reduceAdd(g.value, data[i], true, j);
            }
          }
          for (i = 0; i < n; ++i) {
            if (!filters.zeroExcept(i, offset, zero)) {
              for (j = 0; j < groupIndex[i].length; j++) {
                g = groups[groupIndex[i][j]];
                g.value = reduceRemove(g.value, data[i], false, j);
              }
            }
          }
          return;
        }

        for (i = 0; i < n; ++i) {
          g = groups[groupIndex[i]];
          g.value = reduceAdd(g.value, data[i], true);
        }
        for (i = 0; i < n; ++i) {
          if (!filters.zeroExcept(i, offset, zero)) {
            g = groups[groupIndex[i]];
            g.value = reduceRemove(g.value, data[i], false);
          }
        }
      }

      // Recomputes the group reduce values from scratch.
      // This function is only used when the cardinality is 1.
      function resetOne() {
        var i,
            g = groups[0];

        // Reset the singleton group values.
        g.value = reduceInitial();

        // We add all records and then remove filtered records so that reducers
        // can build an 'unfiltered' view even if there are already filters in
        // place on other dimensions.
        for (i = 0; i < n; ++i) {
          g.value = reduceAdd(g.value, data[i], true);
        }

        for (i = 0; i < n; ++i) {
          if (!filters.zeroExcept(i, offset, zero)) {
            g.value = reduceRemove(g.value, data[i], false);
          }
        }
      }

      // Returns the array of group values, in the dimension's natural order.
      function all() {
        if (resetNeeded) reset(), resetNeeded = false;
        return groups;
      }

      // Returns a new array containing the top K group values, in reduce order.
      function top(k) {
        var top = select(all(), 0, groups.length, k);
        return heap.sort(top, 0, top.length);
      }

      // Sets the reduce behavior for this group to use the specified functions.
      // This method lazily recomputes the reduce values, waiting until needed.
      function reduce(add, remove, initial) {
        reduceAdd = add;
        reduceRemove = remove;
        reduceInitial = initial;
        resetNeeded = true;
        return group;
      }

      // A convenience method for reducing by count.
      function reduceCount() {
        return reduce(crossfilter_reduceIncrement, crossfilter_reduceDecrement, crossfilter_zero);
      }

      // A convenience method for reducing by sum(value).
      function reduceSum(value) {
        return reduce(crossfilter_reduceAdd(value), crossfilter_reduceSubtract(value), crossfilter_zero);
      }

      // Sets the reduce order, using the specified accessor.
      function order(value) {
        select = heapselect_by(valueOf);
        heap = heap_by(valueOf);
        function valueOf(d) { return value(d.value); }
        return group;
      }

      // A convenience method for natural ordering by reduce value.
      function orderNatural() {
        return order(crossfilter_identity);
      }

      // Returns the cardinality of this group, irrespective of any filters.
      function size() {
        return k;
      }

      // Removes this group and associated event listeners.
      function dispose() {
        var i = filterListeners.indexOf(update);
        if (i >= 0) filterListeners.splice(i, 1);
        i = indexListeners.indexOf(add);
        if (i >= 0) indexListeners.splice(i, 1);
        i = removeDataListeners.indexOf(removeData);
        if (i >= 0) removeDataListeners.splice(i, 1);
        return group;
      }

      return reduceCount().orderNatural();
    }

    // A convenience function for generating a singleton group.
    function groupAll() {
      var g = group(crossfilter_null), all = g.all;
      delete g.all;
      delete g.top;
      delete g.order;
      delete g.orderNatural;
      delete g.size;
      g.value = function() { return all()[0].value; };
      return g;
    }

    // Removes this dimension and associated groups and event listeners.
    function dispose() {
      dimensionGroups.forEach(function(group) { group.dispose(); });
      var i = dataListeners.indexOf(preAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = dataListeners.indexOf(postAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = removeDataListeners.indexOf(removeData);
      if (i >= 0) removeDataListeners.splice(i, 1);
      filters.masks[offset] &= zero;
      return filterAll();
    }

    return dimension;
  }

  // A convenience method for groupAll on a dummy dimension.
  // This implementation can be optimized since it always has cardinality 1.
  function groupAll() {
    var group = {
      reduce: reduce,
      reduceCount: reduceCount,
      reduceSum: reduceSum,
      value: value,
      dispose: dispose,
      remove: dispose // for backwards-compatibility
    };

    var reduceValue,
        reduceAdd,
        reduceRemove,
        reduceInitial,
        resetNeeded = true;

    // The group listens to the crossfilter for when any dimension changes, so
    // that it can update the reduce value. It must also listen to the parent
    // dimension for when data is added.
    filterListeners.push(update);
    dataListeners.push(add);

    // For consistency; actually a no-op since resetNeeded is true.
    add(data, 0, n);

    // Incorporates the specified new values into this group.
    function add(newData, n0) {
      var i;

      if (resetNeeded) return;

      // Cycle through all the values.
      for (i = n0; i < n; ++i) {

        // Add all values all the time.
        reduceValue = reduceAdd(reduceValue, data[i], true);

        // Remove the value if filtered.
        if (!filters.zero(i)) {
          reduceValue = reduceRemove(reduceValue, data[i], false);
        }
      }
    }

    // Reduces the specified selected or deselected records.
    function update(filterOne, filterOffset, added, removed, notFilter) {
      var i,
          k,
          n;

      if (resetNeeded) return;

      // Add the added values.
      for (i = 0, n = added.length; i < n; ++i) {
        if (filters.zero(k = added[i])) {
          reduceValue = reduceAdd(reduceValue, data[k], notFilter);
        }
      }

      // Remove the removed values.
      for (i = 0, n = removed.length; i < n; ++i) {
        if (filters.only(k = removed[i], filterOffset, filterOne)) {
          reduceValue = reduceRemove(reduceValue, data[k], notFilter);
        }
      }
    }

    // Recomputes the group reduce value from scratch.
    function reset() {
      var i;

      reduceValue = reduceInitial();

      // Cycle through all the values.
      for (i = 0; i < n; ++i) {

        // Add all values all the time.
        reduceValue = reduceAdd(reduceValue, data[i], true);

        // Remove the value if it is filtered.
        if (!filters.zero(i)) {
          reduceValue = reduceRemove(reduceValue, data[i], false);
        }
      }
    }

    // Sets the reduce behavior for this group to use the specified functions.
    // This method lazily recomputes the reduce value, waiting until needed.
    function reduce(add, remove, initial) {
      reduceAdd = add;
      reduceRemove = remove;
      reduceInitial = initial;
      resetNeeded = true;
      return group;
    }

    // A convenience method for reducing by count.
    function reduceCount() {
      return reduce(crossfilter_reduceIncrement, crossfilter_reduceDecrement, crossfilter_zero);
    }

    // A convenience method for reducing by sum(value).
    function reduceSum(value) {
      return reduce(crossfilter_reduceAdd(value), crossfilter_reduceSubtract(value), crossfilter_zero);
    }

    // Returns the computed reduce value.
    function value() {
      if (resetNeeded) reset(), resetNeeded = false;
      return reduceValue;
    }

    // Removes this group and associated event listeners.
    function dispose() {
      var i = filterListeners.indexOf(update);
      if (i >= 0) filterListeners.splice(i);
      i = dataListeners.indexOf(add);
      if (i >= 0) dataListeners.splice(i);
      return group;
    }

    return reduceCount();
  }

  // Returns the number of records in this crossfilter, irrespective of any filters.
  function size() {
    return n;
  }

  // Returns the raw row data contained in this crossfilter
  function all(){
    return data;
  }

  function onChange(cb){
    if(typeof cb !== 'function'){
      console.warn('onChange callback parameter must be a function!');
      return;
    }
    callbacks.push(cb);
    return function(){
      callbacks.splice(callbacks.indexOf(cb), 1);
    };
  }

  function triggerOnChange(eventName){
    for (var i = 0; i < callbacks.length; i++) {
      callbacks[i](eventName);
    }
  }

  return arguments.length
      ? add(arguments[0])
      : crossfilter;
}

// Returns an array of size n, big enough to store ids up to m.
function crossfilter_index(n, m) {
  return (m < 0x101
      ? crossfilter_array8 : m < 0x10001
      ? crossfilter_array16
      : crossfilter_array32)(n);
}

// Constructs a new array of size n, with sequential values from 0 to n - 1.
function crossfilter_range(n) {
  var range = crossfilter_index(n, n);
  for (var i = -1; ++i < n;) range[i] = i;
  return range;
}

function crossfilter_capacity(w) {
  return w === 8
      ? 0x100 : w === 16
      ? 0x10000
      : 0x100000000;
}

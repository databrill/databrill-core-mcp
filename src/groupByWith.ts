// type GroupByWithFunc<T, K extends string> = (item: T) => K | undefined;
// type MapFunc<T, V, K extends string> = (items: readonly T[], key?: K) => V | undefined;

/**
 * Groups an array of items by a specified key and applies a mapping function to each group.
 *
 * If the groupByFunc returns `undefined`, the item will be skipped.
 * If the mapFunc returns `undefined`, the group will be skipped.
 *
 * @template T - The type of the items in the array.
 * @template K - The type of the key used for grouping.
 * @template V - The type of the values in the resulting grouped object.
 * @param {T[]} array - The array of items to be grouped.
 * @param groupByFunc - The function used to determine the key for grouping.  If it returned `undefined`, the item will be skipped.
 * @param mapFunc - The function used to map each group of items.
 * @returns {Record<K, V>} - An object where the keys are the grouped keys and the values are the mapped results.
 */
export function groupByWith<T, V = T, K extends string = string>(
	array: readonly T[],
	groupByFunc: (item: T) => K | undefined,
	mapFunc: (items: [T, ...T[]], key?: K) => V | undefined,
): Record<K, V> {
	const result1: Record<K, T[]> = {} as Record<K, T[]>;

	for (let i = 0; i < array.length; i++) {
		const item = array[i]!;
		const key = groupByFunc(item);
		if (key === undefined) {
			continue;
		}

		const group0: T[] | undefined = result1[key];
		if (!group0) {
			result1[key] = [item];
		} else {
			group0.push(item);
		}
	}

	const result2: Record<K, V> = {} as Record<K, V>;
	for (const key in result1) {
		const group = result1[key] as unknown as [T, ...T[]];
		const v = mapFunc(group, key);
		// console.log("key:", JSON.stringify(key), "group:", group, "group1:", group1);
		if (v === undefined) {
			// do nothing
		} else {
			result2[key] = v;
		}
	}

	return result2;
}

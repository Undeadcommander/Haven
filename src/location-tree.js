// Iterative traversal supports deep trees without recursive calls. The entry
// intervals make subtree membership a constant-time lookup.
export function createLocationTree(locations) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const children = new Map();
  for (const location of locations) {
    if (!children.has(location.parentId)) children.set(location.parentId, []);
    children.get(location.parentId).push(location);
  }
  const intervals = new Map(), order = [];
  const roots = children.get(null) || [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push([roots[i], false]);
  while (stack.length) {
    const [location, leaving] = stack.pop();
    if (leaving) {
      intervals.get(location.id).end = order.length;
      continue;
    }
    if (intervals.has(location.id)) continue;
    intervals.set(location.id, { start: order.length, end: 0 });
    order.push(location);
    stack.push([location, true]);
    const nested = children.get(location.id) || [];
    for (let i = nested.length - 1; i >= 0; i--) stack.push([nested[i], false]);
  }
  const contains = (ancestor, id) => {
    const parent = intervals.get(ancestor), child = intervals.get(id);
    return !!(parent && child && parent.start <= child.start && child.start < parent.end);
  };
  return { byId, children, order, contains };
}

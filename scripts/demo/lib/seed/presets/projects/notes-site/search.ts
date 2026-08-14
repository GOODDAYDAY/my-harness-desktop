export function search(items, q) {
  return items.filter((i) => i.title.includes(q));
}

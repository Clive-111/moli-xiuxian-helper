// Use game-defined potency, not bundle property order or a fixed name list.
// Older caches without this field keep their relative order after known items.
export function orderMarrows(items) {
  const rank = item => {
    const value = Number(item.marrowValue);
    return Number.isFinite(value) && value > 0 ? value : Infinity;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

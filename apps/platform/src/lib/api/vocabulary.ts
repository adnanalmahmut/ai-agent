/**
 * Runtime lists that have to stay level with a generated union.
 *
 * Some vocabularies are needed as values, not just as types: a form offers
 * them, and the message-catalogue test iterates them to prove each one is
 * translated. `as const satisfies readonly T[]` refuses a value the contract
 * does not declare — but it says nothing about a value the contract *starts*
 * declaring, so a widened union leaves the list quietly short and the new
 * member untranslated.
 *
 * This closes that direction. The intersection is what makes it work: `V` is
 * inferred from the array, and the second operand collapses to `never` unless
 * the array covers the whole union, so an incomplete list fails to compile at
 * the list rather than wherever the missing value first surfaces.
 */
export function everyValueOf<T extends string>() {
  return <const V extends readonly T[]>(
    values: V & ([T] extends [V[number]] ? unknown : never),
  ): V => values;
}

/** Pure comparison used by check-bundles: which bundles differ after a rebuild. Line endings are ignored. */
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

export function staleBundles(before: Map<string, string>, after: Map<string, string>): string[] {
  const stale: string[] = [];
  for (const [file, text] of after) {
    const old = before.get(file);
    if (old === undefined || normalize(old) !== normalize(text)) stale.push(file);
  }
  return stale;
}

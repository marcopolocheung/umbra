/** Production never exposes the retired street-type layer's QA toggle. */
export function streetTypesDebugEnabled(dev: boolean, setting?: string): boolean {
  return dev && setting === "true";
}

export type MutableDeep<T> = T extends ReadonlyArray<infer Element>
  ? Array<MutableDeep<Element>>
  : T extends object
    ? { -readonly [Key in keyof T]: MutableDeep<T[Key]> }
    : T;

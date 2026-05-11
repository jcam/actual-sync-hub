type KeysWithUndefined<T extends object> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type KeysWithoutUndefined<T extends object> = Exclude<keyof T, KeysWithUndefined<T>>;

export type StripUndefined<T extends object> = {
  [K in KeysWithoutUndefined<T>]: T[K];
} & {
  [K in KeysWithUndefined<T>]?: Exclude<T[K], undefined>;
};

export function stripUndefined<T extends object>(value: T): StripUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as StripUndefined<T>;
}

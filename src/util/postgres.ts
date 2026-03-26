import postgres from "postgres";

export const NUMERIC_INTEGER_TYPE: postgres.PostgresType<bigint> = {
  from: [1700],
  to: 1700,
  parse(value: string) {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`Failed to parse numeric integer type: "${value}"`);
    }
  },
  serialize(value: unknown) {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value !== "bigint") {
      throw new Error(`Unexpected numeric integer type: "${value}"`);
    }
    return value.toString();
  },
};

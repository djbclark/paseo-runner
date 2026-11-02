import { DEFAULT_STRING_PATTERN, placeholderName, type Action, type Param } from "./schema";

export type ParamValue = string | number | boolean;
export type ParamValues = Record<string, ParamValue>;
export type BuildArgvResult = { argv: string[] } | { error: string };

function resolveValue(param: Param, supplied: ParamValue | undefined): string | { error: string } | null {
  const value = supplied ?? param.default;
  if (value === undefined) {
    return param.required ? { error: `param "${param.name}" is required` } : null;
  }
  switch (param.type) {
    case "string": {
      if (typeof value !== "string") return { error: `param "${param.name}" must be a string` };
      if (value.includes("\0")) return { error: `param "${param.name}" contains a NUL byte` };
      const pattern = new RegExp(param.pattern ?? DEFAULT_STRING_PATTERN);
      if (!pattern.test(value)) {
        return { error: `param "${param.name}" does not match pattern ${pattern.source}` };
      }
      return value;
    }
    case "int": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return { error: `param "${param.name}" must be an integer` };
      }
      if (param.min !== undefined && value < param.min) {
        return { error: `param "${param.name}" is below the minimum ${param.min}` };
      }
      if (param.max !== undefined && value > param.max) {
        return { error: `param "${param.name}" is above the maximum ${param.max}` };
      }
      return String(value);
    }
    case "enum": {
      if (typeof value !== "string" || !param.choices?.includes(value)) {
        return { error: `param "${param.name}" must be one of the declared choices` };
      }
      return value;
    }
    case "bool": {
      if (typeof value !== "boolean") return { error: `param "${param.name}" must be a boolean` };
      return value ? "true" : "false";
    }
    default:
      return { error: `param "${param.name}" has an unsupported type` };
  }
}

/**
 * Fill an action's argv. Each `{{param}}` element becomes exactly one argv element holding the
 * validated value; values are never concatenated or interpreted. An optional param with no value
 * and no default omits its element.
 */
export function buildArgv(action: Action, values: ParamValues): BuildArgvResult {
  const declared = new Map(action.params.map((param) => [param.name, param]));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) return { error: `unknown param "${key}"` };
  }
  const resolved = new Map<string, string | null>();
  for (const param of action.params) {
    const result = resolveValue(param, Object.hasOwn(values, param.name) ? values[param.name] : undefined);
    if (result !== null && typeof result === "object") return result;
    resolved.set(param.name, result);
  }
  const argv: string[] = [];
  for (const element of action.argv) {
    const name = placeholderName(element);
    if (name === undefined) {
      argv.push(element);
      continue;
    }
    const value = resolved.get(name);
    if (value === undefined) return { error: `argv references undeclared param "${name}"` };
    if (value !== null) argv.push(value);
  }
  return { argv };
}

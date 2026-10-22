import type { ErrorObject } from "ajv";

interface StandaloneValidate {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

declare const validate: StandaloneValidate;
export { validate };
export default validate;

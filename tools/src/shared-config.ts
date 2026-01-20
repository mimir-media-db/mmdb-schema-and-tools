import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SchemaValidator {
  validate: (data: unknown) => boolean;
  errors: any[] | null;
}

export function loadSchema(schemaName: string): SchemaValidator {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  
  // Schema is one level up from dist
  let schemaPath = resolve(__dirname, '../schema', `${schemaName}.json`);
  
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  
  const validate = ajv.compile(schema);
  
  return {
    validate: (data: unknown) => validate(data),
    errors: validate.errors || null
  };
}

export function getSchemaForEntity(entityType: string, schemaVersion: number): string {
  return `${entityType}-v${schemaVersion}`;
}

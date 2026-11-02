/** js-yaml ships no types; the CLI only parses YAML. */
declare module 'js-yaml' {
  export function load(text: string): unknown;
}

// Vite `?raw` imports: the file's bytes as a UTF-8 string.
declare module "*?raw" {
  const text: string;
  export default text;
}

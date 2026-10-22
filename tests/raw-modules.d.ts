// Vite's `?raw` import: the file content as a string (used for CSV fixtures).
declare module "*?raw" {
  const content: string;
  export default content;
}

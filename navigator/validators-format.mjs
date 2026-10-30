// Ajv's error text, formatted identically in Node (runtime Ajv) and in the browser (generated validators),
// so a test can compare what the two say about the same bad document.

export const formatAjvErrors = (errors) => (errors ?? []).map((e) => `data${e.instancePath} ${e.message}`).join("\n  ");

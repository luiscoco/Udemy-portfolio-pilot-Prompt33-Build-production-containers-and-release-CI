/** Provider text is untrusted. Render this only as a React text child, never HTML/Markdown. */
export function newsText(value: string) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 20000); }
export { validatedSourceUrl as sourceLink } from '@portfolio-pilot/contracts';

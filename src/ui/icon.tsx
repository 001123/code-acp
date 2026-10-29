/** Inline SVG markup (bundled as text), e.g. a Tabler icon. */
export function Icon({ svg }: { svg: string }) {
  return <span className="svg-icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}

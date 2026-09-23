'use client';
/** Stable positions update without selection-like flashes. */
export function LiveNumber({text}:{text:string}) {
  return <span className="live-number"><span className="sr-only">{text}</span><span aria-hidden>{[...text].map((char,i)=><span key={`${text.length-1-i}:${char}`} className="digit">{char}</span>)}</span></span>;
}

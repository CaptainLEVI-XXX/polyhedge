'use client';
import { useEffect, useRef, useState } from 'react';
const address='0x4741b6F3CE01C4ac1C387BC9754F31c1c93866F0';
export function ProductFooter(){
  const [message,setMessage]=useState('');
  const [copied,setCopied]=useState(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  async function copy(){
    try {
      await navigator.clipboard.writeText(address);
      setMessage('');setCopied(true);
      if(timer.current)clearTimeout(timer.current);
      timer.current=setTimeout(()=>setCopied(false),1000);
    } catch { setCopied(false);setMessage(`Copy this address: ${address}`); }
  }
  return <footer className="product-footer">
    <div className="footer-actions">
      <div className="footer-support"><span><svg className="support-handshake" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m2 12 4-7 4 1 3-1 5 1 4 7-3 2-5 5-3-1-5-5-4-2Z"/><path d="m10 6-3 4 2 2 4-3 6 6M6 14l5 5m2-5 3 3m-5-1 3 3"/></svg> Support the work</span><button className="support-address" title={address} aria-label={copied?'Address copied':'Copy support address'} onClick={()=>void copy()}><code>0x4741b…866F0</code><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>{copied?<path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round"/>:<><rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 17v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3"/></>}</svg></button></div>
      <a className="github-link" href="https://github.com/CaptainLEVI-XXX/polyhedge" target="_blank" rel="noreferrer noopener" aria-label="polyhedge on GitHub"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.82c.56.1.76-.24.76-.54v-2.1c-3.12.68-3.78-1.32-3.78-1.32-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.71-1.5-2.49-.28-5.11-1.25-5.11-5.54 0-1.22.44-2.22 1.16-3-.12-.28-.5-1.42.11-2.96 0 0 .95-.3 3.08 1.15A10.7 10.7 0 0 1 12 6.18c.95 0 1.9.13 2.8.38 2.14-1.45 3.08-1.15 3.08-1.15.62 1.54.23 2.68.12 2.97.72.77 1.15 1.77 1.15 2.99 0 4.3-2.62 5.25-5.13 5.53.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg><span>GitHub</span></a>
    </div>
    <p className="footer-message" role="status">{message}</p>

  </footer>;
}

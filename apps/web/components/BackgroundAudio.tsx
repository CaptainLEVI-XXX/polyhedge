'use client';
import { useEffect, useRef, useState } from 'react';

export function BackgroundAudio(){
  const audio=useRef<HTMLAudioElement>(null);
  const [playing,setPlaying]=useState(false);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const player=audio.current;
    if(!player)return;
    player.volume=.2;
    // Respect an explicit stop across page reloads. Autoplay is best-effort;
    // browsers that disallow it leave the visible Play button available.
    let stopped=false;try{stopped=localStorage.getItem('polyhedge-music')==='off';}catch{}
    if(!stopped)void player.play().catch(()=>{});
    return()=>player.pause();
  },[]);
  async function toggle(){
    const player=audio.current;if(!player)return;
    if(!player.paused){player.pause();try{localStorage.setItem('polyhedge-music','off');}catch{}return;}
    try{await player.play();try{localStorage.setItem('polyhedge-music','on');}catch{}}catch{setPlaying(false);}
  }
  return <div className="background-audio">
    <audio ref={audio} src="/audio/dancing-through-the-weather.mp3" preload="none" loop onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onError={()=>setFailed(true)}/>
    <button type="button" disabled={failed} onClick={()=>void toggle()} aria-label={playing?'Stop background music':'Play background music'} aria-pressed={playing} title="Dancing Through the Weather">{playing?'Ⅱ Stop music':'♫ Play music'}</button>
    {failed&&<small>Music unavailable</small>}
  </div>;
}

/** Load the local search snapshot at server startup, not on the first person's search. */
export async function register() {
  if(process.env.NEXT_RUNTIME==='nodejs'){
    const { marketIndex }=await import('./lib/markets');
    await marketIndex();
  }
}

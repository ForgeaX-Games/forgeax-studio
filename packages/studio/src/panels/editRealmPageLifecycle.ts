export interface EditRealmPageLifecycleTarget {
  addEventListener(type: 'pagehide', listener: EventListener): void;
  removeEventListener(type: 'pagehide', listener: EventListener): void;
}

/**
 * Release the in-process Editor realm while the old page can still synchronously
 * dispose its WebGPU device. A page entering the back-forward cache stays live
 * and must retain its realm so a restored React tree does not point at a disposed
 * renderer.
 */
export function installEditRealmPageLifecycle(
  target: EditRealmPageLifecycleTarget,
  reset: () => void,
): () => void {
  const onPageHide: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted) return;
    reset();
  };
  target.addEventListener('pagehide', onPageHide);
  return () => { target.removeEventListener('pagehide', onPageHide); };
}

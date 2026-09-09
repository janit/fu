import { useSignal } from "@preact/signals";

/** An anonymous default export: no binding to stamp without a rewrite. */
export default () => {
  const n = useSignal(0);
  return <button type="button" id="anon" onClick={() => n.value++}>anon: {n}</button>;
};

import { useSignal } from "@preact/signals";

/** An arrow-function island: the form the old regex silently missed. */
export const Toggle = () => {
  const on = useSignal(false);
  return (
    <button type="button" id="toggle" onClick={() => on.value = !on.value}>
      {on.value ? "ON" : "OFF"}
    </button>
  );
};
export default Toggle;

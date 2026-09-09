import { useSignal } from "@preact/signals";
import styles from "./counter.module.css";

export default function Counter({ start = 0, label = "count" }) {
  const n = useSignal(start);
  return (
    <button type="button" id="counter" class={styles.badge} onClick={() => n.value++}>
      {label}: {n}
    </button>
  );
}

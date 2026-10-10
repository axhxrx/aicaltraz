/** A minimal observable value + a Preact hook. Snapshots are immutable: always set a new object. */
import { useEffect, useReducer, useRef } from 'preact/hooks';

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (v: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      for (const fn of [...subs]) fn(v);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

const identity = <T,>(v: T) => v;

/** Read a slice of a store; re-renders only when the selected value changes (Object.is). */
export function useStore<T, S = T>(store: Store<T>, select: (v: T) => S = identity as (v: T) => S): S {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const value = select(store.get());
  const sel = useRef(select);
  const last = useRef(value);
  sel.current = select;
  last.current = value;
  useEffect(() => {
    const check = (v: T) => {
      if (!Object.is(sel.current(v), last.current)) force(0);
    };
    check(store.get());
    return store.subscribe(check);
  }, [store]);
  return value;
}

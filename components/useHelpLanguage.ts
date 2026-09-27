"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, parseLanguage, type LanguageCode } from "@/lib/ai/languages";

// The student's language for help cards, Read aloud and the session recap: remembered on this
// device (localStorage), shared by every component on the page, and English on the server render
// (the stored choice takes over right after hydration, so markup never mismatches).

const CHANGE = "inkling:help-language";
/** Holds the choice when storage is unavailable (private mode, blocked site data). */
let memory: LanguageCode | null = null;

function read(): LanguageCode {
  let stored: LanguageCode | null = null;
  try {
    stored = parseLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    // storage blocked: fall back to this page's memory
  }
  return stored ?? memory ?? DEFAULT_LANGUAGE;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === LANGUAGE_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => DEFAULT_LANGUAGE;

export function useHelpLanguage(): [LanguageCode, (language: LanguageCode) => void] {
  const language = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setLanguage = useCallback((next: LanguageCode) => {
    memory = next;
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // not persisted; `memory` keeps it for this page
    }
    window.dispatchEvent(new Event(CHANGE));
  }, []);
  return [language, setLanguage];
}

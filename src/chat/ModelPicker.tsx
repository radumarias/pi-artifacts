import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { effortLabel, providerLabel, type ModelCatalog, type ModelInfo, type ProviderId } from "../../shared/models.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";
import { COMPACT } from "./spend.ts";

const EMPTY: ModelCatalog = { models: [] };

/**
 * The models a chat can pick, shared by every picker and cost panel on the page: loaded once, tried again every ten
 * seconds until it comes, and replaced when someone asks the providers again.
 */
const catalogStore = (() => {
  let catalog = EMPTY;
  let loading: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: ModelCatalog) => {
    catalog = next;
    for (const listener of listeners) listener();
  };
  const load = (): Promise<void> =>
    (loading ??= api.models().then(set, () => {
      loading = undefined;
      setTimeout(load, 10_000);
    }));
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      void load();
      return () => listeners.delete(listener);
    },
    get: () => catalog,
    refresh: async () => set(await api.refreshModels()),
  };
})();

/** The models a chat can pick, once they have come: empty until then. */
export function useCatalog(): ModelCatalog {
  return useSyncExternalStore(catalogStore.subscribe, catalogStore.get);
}

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isIdListOrNull = (value: unknown): value is string[] | null => value === null || isIdList(value);
const MAX_RECENT = 5;

/** "$3", "$0.15", "$2.5": a price per million tokens, short. */
function dollars(value: number): string {
  return `$${Number(value.toPrecision(3))}`;
}

/** The short facts under a model's name: its context, its price per million tokens in and out, whether it sees images. */
function facts(model: ModelInfo): string[] {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`${COMPACT.format(model.contextWindow)} context`);
  if (!model.price) parts.push("price unknown");
  else if (model.price.input === 0 && model.price.output === 0) parts.push("free");
  else parts.push(`${dollars(model.price.input)} / ${dollars(model.price.output)}`);
  if (model.images) parts.push("images");
  return parts;
}

/** "just now", "12 min ago", "3 h ago". */
function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** Whether `model` matches every word of `query`, in its name, id or provider. */
function matches(model: ModelInfo, words: readonly string[]): boolean {
  const text = `${model.name} ${model.id} ${providerLabel(model.provider)}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** One section of the list: favorites, recent picks, or a provider's models. Only a provider's opens and closes. */
interface Section {
  key: string;
  label: string;
  models: ModelInfo[];
  /** Whether it opens and closes. */
  foldable: boolean;
  open: boolean;
}

interface Props {
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  disabled: boolean;
  /** Whether images wait in the composer: a model that cannot see them says so. */
  attachingImages?: boolean;
  /** Ask for a model and effort; the chat answers with the effort the model takes, through its agent state. */
  onChange: (model: string, thinkingLevel?: ModelThinkingLevel) => void;
}

/** The chat's model and, for a model that reasons, its effort. Memoized: the chat re-renders on every streamed token. */
export const ModelPicker = memo(function ModelPicker({ model, thinkingLevel, disabled, attachingImages, onChange }: Props) {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  if (!model) return null;
  const current = catalog.models.find((entry) => entry.id === model);
  const pick = (id: string) => {
    close();
    // Coming from a model that does not reason (or an unlisted one at "off"), ask for no effort: the chat picks the new model's usual one.
    if (id !== model) onChange(id, (current ? !current.efforts.length : thinkingLevel === "off") ? undefined : thinkingLevel);
  };
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={current ? `${current.name} (${providerLabel(current.provider)})` : model}
        onClick={() => setOpen(!open)}
      >
        {/* A deployment's default can be a model the picker does not list. */}
        <span className="model-trigger-name">{current?.name ?? model}</span>
        <Icon size={14} stroke={2}>
          <path d="m6 9 6 6 6-6" />
        </Icon>
      </button>
      {open && <ModelMenu catalog={catalog} current={model} onPick={pick} onClose={close} trigger={trigger} />}
      {current && current.efforts.length > 0 && thinkingLevel && (
        <select
          className="effort"
          aria-label="Effort"
          value={thinkingLevel}
          disabled={disabled}
          onChange={(e) => onChange(model, e.target.value as ModelThinkingLevel)}
        >
          {!current.efforts.includes(thinkingLevel) && <option value={thinkingLevel}>{effortLabel(thinkingLevel)}</option>}
          {current.efforts.map((level) => (
            <option key={level} value={level}>
              {effortLabel(level)}
            </option>
          ))}
        </select>
      )}
      {current && !current.images && attachingImages && (
        <span className="model-note">{current.name} cannot see images: it gets their names only. Pick a model that can to ask about them.</span>
      )}
    </div>
  );
});

const MENU_WIDTH = 400;
const MARGIN = 8;

/**
 * Where the menu goes: just above the trigger, its right edge at the trigger's, as wide as fits the window and as tall
 * as the room above the trigger. Fixed to the window, so a narrow composer (where the picker wraps) cannot push it off
 * screen. Placed again when the window changes size.
 */
function usePlacement(trigger: RefObject<HTMLElement | null>): CSSProperties {
  const measure = (): CSSProperties => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return {};
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * MARGIN);
    const right = Math.min(Math.max(MARGIN, window.innerWidth - rect.right), window.innerWidth - width - MARGIN);
    return { width, right, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(520, rect.top - 2 * MARGIN) };
  };
  const [place, setPlace] = useState(measure);
  // measure reads only the ref and the window: listen once.
  useEffect(() => {
    const onResize = () => setPlace(measure());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return place;
}

/**
 * The list to pick from: a search box over every model; then, until something is typed, the user's favorites and
 * recent picks, and each provider's models in a section that opens and closes (the current model's open at first).
 * Typing lists every match, by provider. Arrow keys move through the list, Enter picks, Escape closes.
 */
function ModelMenu({
  catalog,
  current,
  onPick,
  onClose,
  trigger,
}: {
  catalog: ModelCatalog;
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useStoredState<string[]>("models.favorites", [], isIdList);
  const [recent, setRecent] = useStoredState<string[]>("models.recent", [], isIdList);
  const currentProvider = catalog.models.find((model) => model.id === current)?.provider;
  // The providers whose sections are open; until the user opens or closes one, the current model's.
  const [storedGroups, setOpenGroups] = useStoredState<string[] | null>("models.open", null, isIdListOrNull);
  const openGroups = useMemo(() => storedGroups ?? (currentProvider ? [currentProvider] : []), [storedGroups, currentProvider]);
  // The row the arrow keys are on, by its key, so it stays put while sections above it change.
  const [activeKey, setActiveKey] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const place = usePlacement(trigger);

  // The models by id, and by provider in the catalog's order: made once per catalog, not per keystroke.
  const { byId, byProvider } = useMemo(() => {
    const byProvider = new Map<ProviderId, ModelInfo[]>();
    for (const model of catalog.models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
    return { byId: new Map(catalog.models.map((model) => [model.id, model])), byProvider };
  }, [catalog.models]);

  const sections = useMemo((): Section[] => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    // While searching every group with a match is open; with one provider there is nothing to fold.
    const foldable = !words.length && byProvider.size > 1;
    const groups = [...byProvider].map(
      ([provider, models]): Section => ({
        key: provider,
        label: providerLabel(provider),
        models: words.length ? models.filter((model) => matches(model, words)) : models,
        foldable,
        open: !foldable || openGroups.includes(provider),
      }),
    );
    if (words.length) return groups.filter((group) => group.models.length);
    const pinned = favorites.flatMap((key) => byId.get(key) ?? []);
    const lately = recent.filter((key) => !favorites.includes(key)).flatMap((key) => byId.get(key) ?? []);
    return [
      ...(pinned.length ? [{ key: "favorites", label: "Favorites", models: pinned, foldable: false, open: true }] : []),
      ...(lately.length ? [{ key: "recent", label: "Recent", models: lately, foldable: false, open: true }] : []),
      ...groups,
    ];
  }, [byId, byProvider, query, favorites, recent, openGroups]);

  // What the arrow keys move through: the models of every open section, in order; and each row's place among them.
  const { options, indexOf } = useMemo(() => {
    const options = sections.flatMap((section) => (section.open ? section.models.map((model) => ({ key: `${section.key}:${model.id}`, model })) : []));
    return { options, indexOf: new Map(options.map((option, index) => [option.key, index])) };
  }, [sections]);
  const found = activeKey === undefined ? -1 : (indexOf.get(activeKey) ?? -1);
  // Until the user moves, the current model where the list first shows it, else the first row.
  const activeIndex =
    found >= 0
      ? found
      : Math.max(
          0,
          options.findIndex((option) => option.model.id === current),
        );
  const setActive = (index: number) => setActiveKey(options[index]?.key);
  const optionId = (key: string) => `${id}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // Keep the active row in view.
  useEffect(() => {
    const key = options[activeIndex]?.key;
    if (key) document.getElementById(optionId(key))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, options]);

  // A click anywhere else closes the menu (the trigger toggles it itself).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !trigger.current?.contains(target)) onClose();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose, trigger]);

  const choose = (model: ModelInfo) => {
    setRecent([model.id, ...recent.filter((key) => key !== model.id)].slice(0, MAX_RECENT));
    onPick(model.id);
  };
  const toggleFavorite = (model: ModelInfo) =>
    setFavorites(favorites.includes(model.id) ? favorites.filter((key) => key !== model.id) : [...favorites, model.id]);
  const toggleGroup = (section: Section) => {
    const shown = new Set(openGroups);
    if (section.open) shown.delete(section.key);
    else shown.add(section.key);
    setOpenGroups([...shown]);
  };
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await catalogStore.refresh();
    } catch (error) {
      setRefreshError(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
    if (step && options.length) {
      event.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, activeIndex + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option.model);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const total = catalog.models.length;
  const providerCount = byProvider.size;
  return (
    <div className="model-menu" role="dialog" aria-label="Choose a model" ref={box} style={place}>
      <label className="model-search">
        <Icon size={16} stroke={2}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </Icon>
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={options[activeIndex] ? optionId(options[activeIndex].key) : undefined}
          aria-label="Search models"
          placeholder={total ? `Search ${total} models` : "Loading models…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(undefined);
            list.current?.scrollTo({ top: 0 });
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="model-list" id={`${id}-list`} role="listbox" aria-label="Models" ref={list}>
        {sections.map((section) => (
          <div key={section.key} role="group" aria-label={section.label} className="model-section">
            {section.foldable ? (
              <button type="button" className="model-group" aria-expanded={section.open} tabIndex={-1} onClick={() => toggleGroup(section)}>
                <Icon size={14} stroke={2}>
                  <path d={section.open ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} />
                </Icon>
                <span>{section.label}</span>
                <small>{section.models.length}</small>
              </button>
            ) : (
              <div className="model-group static">
                <span>{section.label}</span>
                {query && <small>{section.models.length}</small>}
              </div>
            )}
            {section.open &&
              section.models.map((model) => {
                const key = `${section.key}:${model.id}`;
                const index = indexOf.get(key) ?? -1;
                const favorite = favorites.includes(model.id);
                return (
                  <div
                    key={key}
                    id={optionId(key)}
                    role="option"
                    aria-selected={model.id === current}
                    className={`model-option${index === activeIndex ? " active" : ""}${model.id === current ? " current" : ""}`}
                    onMouseMove={() => index !== activeIndex && setActive(index)}
                    onClick={() => choose(model)}
                  >
                    <span className="model-option-text">
                      <span className="model-option-name">{model.name}</span>
                      <small
                        title={
                          model.price
                            ? "Context window; dollars per million input / output tokens"
                            : "No list price is known for this model: its replies count as free in the cost panel."
                        }
                      >
                        {/* Favorites and recent picks mix providers: say whose each is. */}
                        {(section.key === "favorites" || section.key === "recent" ? [providerLabel(model.provider), ...facts(model)] : facts(model)).join(
                          " · ",
                        )}
                      </small>
                    </span>
                    {model.id === current && (
                      <Icon size={16} stroke={2.2}>
                        <path d="m5 12 5 5 9-10" />
                      </Icon>
                    )}
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`model-star${favorite ? " on" : ""}`}
                      aria-label={favorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`}
                      title={favorite ? "Remove from favorites" : "Add to favorites"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite(model);
                      }}
                    >
                      <Icon size={15} stroke={1.8}>
                        <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill={favorite ? "currentColor" : "none"} />
                      </Icon>
                    </button>
                  </div>
                );
              })}
          </div>
        ))}
        {query && !sections.length && <div className="model-empty">No model matches “{query}”.</div>}
      </div>
      <div className="model-menu-foot">
        <small>
          {refreshError
            ? `Could not check: ${refreshError}`
            : `${total} models from ${providerCount} ${providerCount === 1 ? "provider" : "providers"}${catalog.checkedAt ? ` · checked ${ago(catalog.checkedAt)}` : ""}`}
        </small>
        <button
          type="button"
          className="icon-button"
          onClick={refresh}
          disabled={refreshing}
          title="Ask AI Gateway's providers for their models again, for a key added since"
          aria-label="Check for new models"
        >
          <Icon size={16} stroke={2}>
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
          </Icon>
        </button>
      </div>
    </div>
  );
}

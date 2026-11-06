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
import {
  AUTO_MODEL,
  choiceLabel,
  EFFORT_LABELS,
  effortLabel,
  pricePerMillion,
  providerLabel,
  type ModelCatalog,
  type ModelInfo,
  type ProviderId,
} from "../../shared/models.ts";
import { errorMessage, searchWords } from "../../shared/util.ts";
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

/** The short facts under a model's name: its context, its price per million tokens in and out, whether it sees images. */
function facts(model: ModelInfo): string[] {
  const parts: string[] = model.failing ? ["not answering"] : [];
  if (model.contextWindow) parts.push(`${COMPACT.format(model.contextWindow)} context`);
  if (!model.price) parts.push("price unknown");
  else if (model.price.input === 0 && model.price.output === 0) parts.push("free");
  else parts.push(`${pricePerMillion(model.price.input)} / ${pricePerMillion(model.price.output)}`);
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

/** Auto as the list shows it, above the models: a router picks the model and effort for each message. */
interface AutoOption {
  id: typeof AUTO_MODEL;
  name: string;
}
const AUTO_OPTION: AutoOption = { id: AUTO_MODEL, name: "Auto" };
/** What Auto does, under its name in the list and on the trigger. */
const AUTO_HINT = "Picks the model and effort for each message";

/** A row of the list: a model, or Auto. */
type Option = ModelInfo | AutoOption;
const isAutoOption = (option: Option): option is AutoOption => option.id === AUTO_MODEL;

/** One section of the list: Auto, favorites, recent picks, or a provider's models. Only a provider's opens and closes. */
interface Section {
  key: string;
  /** Its heading; none for Auto's, a row of its own. */
  label?: string;
  models: Option[];
  /** Whether it opens and closes. */
  foldable: boolean;
  open: boolean;
}

interface Props {
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Whether the chat is on Auto: `model` and `thinkingLevel` are then the ones its last message was answered with. */
  auto?: boolean;
  disabled: boolean;
  /** Whether images wait in the composer: a model that cannot see them says so. */
  attachingImages?: boolean;
  /** Ask for a model and effort; the chat answers with the effort the model takes, through its agent state. */
  onChange: (model: string, thinkingLevel?: ModelThinkingLevel) => void;
}

/**
 * The chat's model at the right of the row under the input, by name and, for a model that reasons, its effort ("High"),
 * which its menu also sets. On Auto, "Auto" and the model it last picked. Memoized: the chat re-renders on every
 * streamed token.
 */
export const ModelPicker = memo(function ModelPicker({ model, thinkingLevel, auto = false, disabled, attachingImages, onChange }: Props) {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  // A trigger turned off (the chat lost its socket) closes the menu: its picks would go nowhere.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (!model) return null;
  const current = catalog.models.find((entry) => entry.id === model);
  const pick = (id: string) => {
    close();
    if (id === AUTO_MODEL) {
      if (!auto) onChange(AUTO_MODEL);
      return;
    }
    // Coming from a model that does not reason (or an unlisted one at "off"), ask for no effort: the chat picks the new
    // model's usual one; so too from Auto, whose effort was picked for another model.
    if (id !== model || auto) onChange(id, auto || (current ? !current.efforts.length : thinkingLevel === "off") ? undefined : thinkingLevel);
  };
  // The effort the menu offers, for a model that reasons: its levels, plus the chat's own when the model does not list it.
  // None on Auto, which picks it.
  const efforts =
    current?.efforts.length && thinkingLevel ? (current.efforts.includes(thinkingLevel) ? current.efforts : [thinkingLevel, ...current.efforts]) : [];
  const name = current?.name ?? model;
  const effort = efforts.length ? thinkingLevel : undefined;
  const full = current ? `${current.name} (${providerLabel(current.provider)})` : model;
  // On Auto: the model, and effort, its last message was answered with.
  const last = choiceLabel(current, model, effort);
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={auto ? `Model: Auto, last ${last}` : effort ? `Model: ${name}, ${effortLabel(effort).toLowerCase()}` : `Model: ${name}`}
        title={auto ? `Auto: ${AUTO_HINT.toLowerCase()}. Last: ${last}` : effort ? `${full} · ${effortLabel(effort)}` : full}
        onClick={() => setOpen(!open)}
      >
        {/* A deployment's default can be a model the picker does not list. */}
        <span className="model-trigger-name">{auto ? AUTO_OPTION.name : name}</span>
        {auto ? (
          <span className="model-trigger-effort model-trigger-pick">{name}</span>
        ) : (
          effort && <span className="model-trigger-effort">{EFFORT_LABELS[effort]}</span>
        )}
      </button>
      {open && (
        <ModelMenu
          catalog={catalog}
          current={auto ? AUTO_MODEL : model}
          efforts={auto ? [] : efforts}
          thinkingLevel={thinkingLevel}
          onPick={pick}
          onEffort={(level) => level !== thinkingLevel && onChange(model, level)}
          onClose={close}
          trigger={trigger}
        />
      )}
      {!auto && current && !current.images && attachingImages && (
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
 * Typing lists every match, by provider. Arrow keys move through the list, Enter picks, Escape closes. Under the
 * list, the current model's efforts, when it reasons: picking one keeps the menu open, so the change shows.
 */
function ModelMenu({
  catalog,
  current,
  efforts,
  thinkingLevel,
  onPick,
  onEffort,
  onClose,
  trigger,
}: {
  catalog: ModelCatalog;
  current: string;
  efforts: readonly ModelThinkingLevel[];
  thinkingLevel?: ModelThinkingLevel;
  onPick: (id: string) => void;
  onEffort: (level: ModelThinkingLevel) => void;
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
    for (const model of catalog.models) {
      const models = byProvider.get(model.provider);
      if (models) models.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return { byId: new Map(catalog.models.map((model) => [model.id, model])), byProvider };
  }, [catalog.models]);

  const sections = useMemo((): Section[] => {
    const words = searchWords(query);
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
    const autoSection: Section = { key: "auto", models: [AUTO_OPTION], foldable: false, open: true };
    if (words.length) return [...(words.every((word) => "auto".startsWith(word)) ? [autoSection] : []), ...groups.filter((group) => group.models.length)];
    const pinned = favorites.flatMap((key) => byId.get(key) ?? []);
    const lately = recent.filter((key) => !favorites.includes(key)).flatMap((key) => byId.get(key) ?? []);
    return [
      autoSection,
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

  // Whether the pointer moved the active row last: it is under the pointer, so in view already.
  const byPointer = useRef(false);
  const hover = (index: number) => {
    byPointer.current = true;
    if (index !== activeIndex) setActive(index);
  };

  // Keep the active row in view, when the keys (or the list) moved it: scrolling to a row the pointer is on, half
  // shown at the list's edge, would slide the next row under the pointer and keep the list creeping.
  useEffect(() => {
    if (byPointer.current) return;
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

  const choose = (model: Option) => {
    if (!isAutoOption(model)) setRecent([model.id, ...recent.filter((key) => key !== model.id)].slice(0, MAX_RECENT));
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
    byPointer.current = false;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
    if (step && options.length) {
      event.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, activeIndex + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option.model);
    }
  };
  // Escape closes the menu from anywhere in it: the search box, an effort or the refresh button.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  const total = catalog.models.length;
  const providerCount = byProvider.size;
  return (
    <div className="model-menu" role="dialog" aria-label="Choose a model" ref={box} style={place} onKeyDown={onMenuKeyDown}>
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
          <div key={section.key} role="group" aria-label={section.label ?? AUTO_OPTION.name} className="model-section">
            {section.label === undefined ? null : section.foldable ? (
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
                const auto = isAutoOption(model);
                const favorite = !auto && favorites.includes(model.id);
                return (
                  <div
                    key={key}
                    id={optionId(key)}
                    role="option"
                    aria-selected={model.id === current}
                    className={`model-option${auto ? " model-auto" : ""}${index === activeIndex ? " active" : ""}${model.id === current ? " current" : ""}`}
                    onMouseMove={() => hover(index)}
                    onClick={() => choose(model)}
                  >
                    <span className="model-option-text">
                      <span className="model-option-name">{model.name}</span>
                      {auto ? (
                        <small>{AUTO_HINT}</small>
                      ) : (
                        <small
                          title={
                            model.failing
                              ? `Not answering when last tried, so Auto leaves it out: ${model.failing}`
                              : model.price
                              ? "Context window; dollars per million input / output tokens"
                              : "No list price is known for this model: the cost panel leaves its replies out of the total."
                          }
                        >
                          {/* Favorites and recent picks mix providers: say whose each is. */}
                          {(section.key === "favorites" || section.key === "recent" ? [providerLabel(model.provider), ...facts(model)] : facts(model)).join(
                            " · ",
                          )}
                        </small>
                      )}
                    </span>
                    {model.id === current && (
                      <Icon size={16} stroke={2.2}>
                        <path d="m5 12 5 5 9-10" />
                      </Icon>
                    )}
                    {!auto && (
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
                    )}
                  </div>
                );
              })}
          </div>
        ))}
        {query && !sections.length && <div className="model-empty">No model matches “{query}”.</div>}
      </div>
      {efforts.length > 0 && (
        <div className="model-effort" role="group" aria-label="Effort">
          <span>Effort</span>
          {efforts.map((level) => (
            <button
              key={level}
              type="button"
              className="chip"
              aria-pressed={level === thinkingLevel}
              // A click keeps the focus in the search box, so the arrow keys and Enter still work on the list.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onEffort(level)}
            >
              {EFFORT_LABELS[level]}
            </button>
          ))}
        </div>
      )}
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

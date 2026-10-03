export interface Draft {
  supplier: string;
  number: string;
  amount: string;
  dueDate: string;
}

export const STEPS = ["Поставщик", "Сумма и срок", "Проверка"] as const;
export const suppliers = [
  "ООО «Северный склад»",
  "АО «ТехноСнаб»",
  "ИП Кравцова Н. А.",
  "ООО «Промтара»",
];

// Черновики и накладные живут в памяти процесса: пример показывает экран, а не
// хранение. Память конечна: черновиков не больше MAX_DRAFTS (брошенные
// вытесняются старейшими), накладных — последние MAX_REGISTERED.
const MAX_DRAFTS = 200;
const MAX_REGISTERED = 100;
const drafts = new Map<string, Draft>();
export interface Registered {
  id: number;
  number: string;
  supplier: string;
  amount: number;
  dueDate: string;
}
const registered: Registered[] = [];
let nextId = 1;

// Пределы длины полей: одни и те же числа уходят в maxlength разметки и в
// проверку на сервере — браузерный maxlength обходится любым запросом мимо формы.
export const LIMITS = { number: 40, amount: 15, dueDate: 10 } as const;
export const FIELD_LABELS: Record<keyof typeof LIMITS, string> = {
  number: "Номер накладной",
  amount: "Сумма",
  dueDate: "Оплатить до",
};

export function stepOf(raw: string | undefined): 1 | 2 | 3 {
  return raw === "2" ? 2 : raw === "3" ? 3 : 1;
}

export function validate(step: 1 | 2 | 3, draft: Draft): string | undefined {
  const tooLong = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).find(
    (name) => draft[name].length > LIMITS[name],
  );
  if (tooLong) return `Поле «${FIELD_LABELS[tooLong]}» длиннее ${LIMITS[tooLong]} символов.`;
  if (step === 1) {
    if (!suppliers.includes(draft.supplier)) return "Выберите поставщика из списка.";
    if (!draft.number) return "Укажите номер накладной.";
  }
  if (step === 2) {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) return "Сумма — число больше нуля.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) return "Укажите срок оплаты.";
  }
  return undefined;
}

export function reachableStep(step: 1 | 2 | 3, draft: Draft): 1 | 2 | 3 {
  if (step > 1 && validate(1, draft)) return 1;
  if (step > 2 && validate(2, draft)) return 2;
  return step;
}

export function emptyDraft(): Draft {
  return { supplier: "", number: "", amount: "", dueDate: "" };
}

export function findDraft(id: string): Draft | undefined {
  return drafts.get(id);
}
export function findRegistered(id: string | undefined): Registered | undefined {
  return registered.find((invoice) => String(invoice.id) === id);
}
export function saveDraft(id: string, draft: Draft): void {
  drafts.delete(id);
  drafts.set(id, draft);
  if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
}
export function registerDraft(draftId: string, draft: Draft): number {
  drafts.delete(draftId);
  const id = nextId++;
  registered.push({
    id,
    number: draft.number,
    supplier: draft.supplier,
    amount: Number(draft.amount),
    dueDate: draft.dueDate,
  });
  if (registered.length > MAX_REGISTERED) registered.splice(0, registered.length - MAX_REGISTERED);
  return id;
}

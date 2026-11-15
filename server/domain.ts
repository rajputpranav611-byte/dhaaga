import type { Role } from "./security";

export type DoseStatus = "pending" | "taken" | "late" | "missed" | "skipped";

export function transitionDose(current: DoseStatus, requested: "taken" | "skipped", scheduledAt: number, now: number): DoseStatus | null {
  if (current !== "pending" && !(current === "missed" && requested === "taken")) return null;
  return requested === "taken" && scheduledAt < now ? "late" : requested;
}

export function canRolePerform(role: Role, action: "view" | "manage_medicine" | "manage_appointment" | "approve") {
  const permissions: Record<Role, readonly string[]> = {
    Elder: ["view", "manage_medicine", "manage_appointment", "approve"],
    Caretaker: ["view", "manage_medicine", "manage_appointment"],
    Family: ["view", "manage_appointment"],
  };
  return permissions[role].includes(action);
}

const drugGroups = {
  ace: ["lisinopril", "enalapril", "ramipril", "perindopril", "captopril"],
  nsaid: ["ibuprofen", "naproxen", "diclofenac", "celecoxib", "indomethacin", "ketorolac", "meloxicam"],
  ssri: ["escitalopram", "citalopram", "sertraline", "fluoxetine", "paroxetine", "fluvoxamine"],
  nitrate: ["nitroglycerin", "isosorbide", "nitrate"],
  paracetamol: ["paracetamol", "acetaminophen"],
};
const hasGroupDrug = (text: string, group: readonly string[]) => group.some((drug) => text.includes(drug));

export function findInteractionWarnings(proposed: string, existing: string[]) {
  const normalized = proposed.toLowerCase();
  const medicines = existing.map((item) => item.toLowerCase());
  const warnings: { title: string; note: string }[] = [];
  const add = (title: string, note: string) => warnings.push({ title, note: `${note} Ask your doctor or pharmacist.` });
  const has = (needle: string) => medicines.some((medicine) => medicine.includes(needle));
  const withGroup = (group: readonly string[]) => medicines.some((medicine) => hasGroupDrug(medicine, group));

  if ((normalized.includes("warfarin") && (has("aspirin") || hasGroupDrug(normalized, drugGroups.nsaid))) ||
      (normalized.includes("aspirin") && has("warfarin")) ||
      (hasGroupDrug(normalized, drugGroups.nsaid) && has("warfarin"))) {
    add("Warfarin and aspirin / NSAIDs", "This combination can increase bleeding risk.");
  }
  if ((hasGroupDrug(normalized, drugGroups.ace) && (has("potassium") || has("spironolactone"))) ||
      (normalized.includes("potassium") && (withGroup(drugGroups.ace) || has("spironolactone"))) ||
      (normalized.includes("spironolactone") && withGroup(drugGroups.ace))) {
    add("ACE inhibitor, potassium, or spironolactone", "This combination may raise potassium levels.");
  }
  if ((hasGroupDrug(normalized, drugGroups.nitrate) && has("sildenafil")) || (normalized.includes("sildenafil") && withGroup(drugGroups.nitrate))) {
    add("Nitrate medicine and sildenafil", "This combination can cause a dangerous drop in blood pressure.");
  }
  if ((hasGroupDrug(normalized, drugGroups.ssri) && hasGroupDrug(medicines.join(" "), drugGroups.nsaid)) ||
      (hasGroupDrug(normalized, drugGroups.nsaid) && hasGroupDrug(medicines.join(" "), drugGroups.ssri))) {
    add("SSRI and an anti-inflammatory", "This combination can increase bleeding risk.");
  }
  if (hasGroupDrug(normalized, drugGroups.nsaid) && withGroup(drugGroups.nsaid)) {
    add("Two anti-inflammatory medicines", "Taking two NSAIDs together may increase side effects.");
  }
  if (hasGroupDrug(normalized, drugGroups.paracetamol) && hasGroupDrug(medicines.join(" "), drugGroups.paracetamol)) {
    add("Possible duplicate paracetamol", "These names refer to the same medicine and may lead to taking too much.");
  }
  return warnings;
}

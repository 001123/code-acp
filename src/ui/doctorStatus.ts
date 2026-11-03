import type { DoctorStatus } from "../doctor";
import type { MessageKey } from "./l10n";
import warningIcon from "@tabler/icons/outline/alert-triangle.svg";
import okIcon from "@tabler/icons/outline/circle-check.svg";
import skippedIcon from "@tabler/icons/outline/circle-dashed.svg";
import errorIcon from "@tabler/icons/outline/circle-x.svg";
import loaderIcon from "@tabler/icons/outline/loader-2.svg";

export type DoctorRowStatus = DoctorStatus | "pending" | "skipped";

/** How a check's status looks, on the Doctor tab and in the chat's first-run panel. */
export const DOCTOR_STATUS: Record<DoctorRowStatus, { readonly icon: string; readonly label: MessageKey }> = {
  ok: { icon: okIcon, label: "doctor.status.ok" },
  warning: { icon: warningIcon, label: "doctor.status.warning" },
  error: { icon: errorIcon, label: "doctor.status.error" },
  pending: { icon: loaderIcon, label: "doctor.status.pending" },
  skipped: { icon: skippedIcon, label: "doctor.status.skipped" },
};

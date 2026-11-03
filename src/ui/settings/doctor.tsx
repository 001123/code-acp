import type { DoctorFix, DoctorRow, DoctorState } from "../../doctor";
import { DOCTOR_STATUS, type DoctorRowStatus } from "../doctorStatus";
import { Icon } from "../icon";
import { useL10n, type MessageKey } from "../l10n";
import { post } from "./post";
import playIcon from "@tabler/icons/outline/player-play.svg";
import stopIcon from "@tabler/icons/outline/player-stop.svg";
import refreshIcon from "@tabler/icons/outline/refresh.svg";

const FIX_LABEL: Record<DoctorFix["type"], MessageKey> = {
  open: "doctor.fix.open",
  manageAgents: "doctor.fix.manageAgents",
  login: "doctor.fix.login",
  showLog: "doctor.fix.showLog",
};

const GROUPS: ReadonlyArray<{ readonly id: DoctorRow["group"]; readonly label: MessageKey }> = [
  { id: "tools", label: "doctor.group.tools" },
  { id: "agents", label: "doctor.group.agents" },
];

function Row({ row, running }: { row: DoctorRow; running: boolean }) {
  const { t } = useL10n();
  const { result } = row;
  const status: DoctorRowStatus = result?.status ?? (running ? "pending" : "skipped");
  const { icon, label } = DOCTOR_STATUS[status];
  return (
    <div className={`doctor-row ${status}`}>
      <span className="doctor-status" role="img" aria-label={t(label)} title={t(label)}>
        <Icon svg={icon} />
      </span>
      <div className="doctor-body">
        <div className="doctor-title">
          <span className="doctor-name">{row.label}</span>
          {result?.description && <span className="doctor-version">{result.description}</span>}
        </div>
        {result?.detail && <div className="doctor-detail">{result.detail}</div>}
      </div>
      {result?.fix && (
        <button className="secondary" onClick={() => post({ type: "doctorFix", id: row.id })}>
          {t(FIX_LABEL[result.fix.type])}
        </button>
      )}
    </div>
  );
}

export function DoctorTab({ doctor }: { doctor: DoctorState }) {
  const { t } = useL10n();
  const { rows, running } = doctor;
  const finished = rows.length > 0 && rows.every((row) => row.result);
  const problems = rows.filter((row) => row.result && row.result.status !== "ok").length;
  const summary = running
    ? t("doctor.checking")
    : !rows.length
      ? t("doctor.idle")
      : problems
        ? t("doctor.problems", problems)
        : finished
          ? t("doctor.allGood")
          : t("doctor.status.skipped");
  return (
    <>
      <div className="doctor-toolbar">
        {running ? (
          <button className="secondary with-icon" onClick={() => post({ type: "doctorStop" })}>
            <Icon svg={stopIcon} />
            {t("doctor.stop")}
          </button>
        ) : rows.length ? (
          <button className="secondary with-icon" onClick={() => post({ type: "doctorRun" })}>
            <Icon svg={refreshIcon} />
            {t("doctor.runAgain")}
          </button>
        ) : (
          <button className="with-icon" onClick={() => post({ type: "doctorRun" })}>
            <Icon svg={playIcon} />
            {t("doctor.run")}
          </button>
        )}
        <span className="doctor-summary" role="status">
          {summary}
        </span>
      </div>
      {GROUPS.map(({ id, label }) => {
        const inGroup = rows.filter((row) => row.group === id);
        return (
          inGroup.length > 0 && (
            <section key={id} className="doctor-group">
              <h3>{t(label)}</h3>
              <div className="card">
                {inGroup.map((row) => (
                  <Row key={row.id} row={row} running={running} />
                ))}
              </div>
            </section>
          )
        );
      })}
    </>
  );
}

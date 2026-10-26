import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Eye, FolderInput, ScanLine, Trash2 } from "lucide-react";
import { archivePathSchema, type ScanItem } from "@elvis/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtBytes, fmtDateTime } from "../lib/format";
import { useToast } from "../lib/toast";
import {
  Badge,
  Card,
  Field,
  Loading,
  Modal,
  PageHeader,
} from "../components/ui";
import { PersonnelSheets } from "./inbox/PersonnelSheets";

/** Posteingang: Personalbögen aus dem Online-Formular und per „Scan an E-Mail“ empfangene PDFs (während eines Einsatzes automatisch in dessen Dokumenten) */
export function ScanPage() {
  const toast = useToast();
  const admin = !!useAuth().user?.isAdmin;
  const { data, isLoading } = useQuery({
    queryKey: ["scans"],
    queryFn: api.scans,
  });
  const [assigning, setAssigning] = useState<ScanItem | null>(null);
  const [folderPath, setFolderPath] = useState("");

  const assign = useMutation({
    mutationFn: (v: {
      scan: ScanItem;
      incidentId: number;
      folderPath: string;
    }) =>
      api.assignScan(v.scan.id, {
        incidentId: v.incidentId,
        folderPath: v.folderPath,
      }),
    onSuccess: (s) => (
      setAssigning(null),
      toast("success", `Abgelegt unter „${s.archivedPath}“`)
    ),
    onError: (e) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.removeScan(id),
    onError: (e) => toast("error", e.message),
  });

  if (isLoading || !data) return <Loading />;
  const { status, scans } = data;
  const incident = status.archive.incident;
  const validPath = archivePathSchema.safeParse(folderPath);

  return (
    <>
      <PageHeader
        title="Posteingang"
        subtitle="Hier werden Dokumente angezeigt, die ELVIS auf unterschiedlichen Wegen zugespielt worden sind."
      />
      <div className="stack">
        <PersonnelSheets />
        <Card title="Scans" icon={<ScanLine size={18} />} className="span-2">
          <p className="muted">
            {incident && status.archive.enabled
              ? `Per „Scan an E-Mail“ empfangen; neue Scans werden zusätzlich im Einsatz „${incident.title}“ unter „${status.archive.path || "/"}“ abgelegt.`
              : "Per „Scan an E-Mail“ empfangen: am Multifunktionsgerät Scannen → E-Mail wählen und als Empfänger die ELVIS-Adresse angeben."}
          </p>
          {!status.listening || !status.enabled ? (
            <p className="tone-alarm">
              {!status.enabled
                ? "Der Scan-Empfang ist abgeschaltet."
                : `Der Scan-Empfänger läuft nicht${status.error ? ` (${status.error})` : ""}.`}{" "}
              {admin ? (
                <>
                  Einstellungen unter{" "}
                  <Link to="/einstellungen#scannen">
                    Einstellungen → Scannen
                  </Link>
                  .
                </>
              ) : (
                "Bitte einen Admin informieren."
              )}
            </p>
          ) : null}
          {scans.length === 0 ? (
            <p className="muted">Noch keine Scans.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Empfangen</th>
                    <th>Datei</th>
                    <th>Absender</th>
                    <th>Ablage</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{fmtDateTime(s.receivedAt)}</td>
                      <td>
                        <a
                          href={`/api/scans/${s.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {s.filename}
                        </a>
                        <span className="cell-sub">
                          {fmtBytes(s.sizeBytes)}
                          {s.subject && ` · ${s.subject}`}
                        </span>
                      </td>
                      <td>
                        {s.sender || "–"}
                        <span className="cell-sub">{s.sourceIp}</span>
                      </td>
                      <td>
                        {s.archivedPath ? (
                          <>
                            {s.incidentId === incident?.id ? (
                              <Link to="/einsatz/dokumente">
                                {s.archivedPath}
                              </Link>
                            ) : (
                              s.archivedPath
                            )}
                            <span className="cell-sub">
                              {s.incidentTitle ?? "Einsatz gelöscht"}
                              {s.assignedBy &&
                                s.assignedBy !== "Eingang" &&
                                s.assignedBy !== "Scan-Eingang" &&
                                ` · ${s.assignedBy}`}
                            </span>
                          </>
                        ) : (
                          <Badge tone="muted">nicht zugeordnet</Badge>
                        )}
                        {s.message && (
                          <span className="cell-sub tone-alarm">
                            {s.message}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="btn-row">
                          <a
                            className="btn btn-ghost btn-icon"
                            href={`/api/scans/${s.id}/file`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Ansehen"
                            title="Ansehen"
                          >
                            <Eye size={16} />
                          </a>
                          <a
                            className="btn btn-ghost btn-icon"
                            href={`/api/scans/${s.id}/file?download=1`}
                            aria-label="Herunterladen"
                            title="Herunterladen"
                          >
                            <Download size={16} />
                          </a>
                          {incident && s.incidentId !== incident.id && (
                            <button
                              className="btn btn-ghost btn-icon"
                              onClick={() => (
                                setFolderPath(status.archive.path),
                                setAssigning(s)
                              )}
                              aria-label="Im Einsatz ablegen"
                              title={`Im Einsatz „${incident.title}“ ablegen`}
                            >
                              <FolderInput size={16} />
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-icon"
                            onClick={() =>
                              window.confirm(
                                `Scan „${s.filename}“ aus dem Posteingang löschen?${s.archivedPath ? "\n\nDas abgelegte Dokument im Einsatz bleibt erhalten." : ""}`,
                              ) && remove.mutate(s.id)
                            }
                            aria-label="Löschen"
                            title="Aus dem Posteingang löschen"
                          >
                            <Trash2 size={16} />
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={!!assigning && !!incident}
        title="Im Einsatz ablegen"
        onClose={() => setAssigning(null)}
      >
        {assigning && incident && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              assign.mutate({
                scan: assigning,
                incidentId: incident.id,
                folderPath,
              });
            }}
          >
            <p>
              „{assigning.filename}“ in der Dokumentverwaltung des Einsatzes „
              {incident.title}“ ablegen.
            </p>
            <Field
              label="Ordner"
              hint="Leer = oberste Ebene. Fehlende Ordner werden angelegt; Platzhalter wie {{datum.iso}} sind erlaubt."
            >
              <input
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                maxLength={200}
                autoFocus
              />
            </Field>
            {!validPath.success && (
              <p className="tone-alarm">{validPath.error.issues[0]?.message}</p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setAssigning(null)}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!validPath.success || assign.isPending}
              >
                Ablegen
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

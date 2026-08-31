export interface ErrorScreenProps {
  title: string;
  message: string;
  detail?: string[];
}

/**
 * Shown when a demo cannot be played at all — a manifest from a newer schema version, a
 * missing folder. Deliberately explicit: the person who sees this is usually the sales
 * engineer, minutes before a meeting.
 */
export function ErrorScreen({ title, message, detail = [] }: ErrorScreenProps): React.ReactElement {
  return (
    <div className="dp-error" role="alert">
      <div className="dp-error-card">
        <h1>{title}</h1>
        <p>{message}</p>
        {detail.length > 0 ? (
          <ul className="dp-error-detail">
            {detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

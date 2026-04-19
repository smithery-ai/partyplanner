const apiBase = "/api/workflow";

export default function Home() {
  return (
    <main>
      <h1>Workflow Next.js Example</h1>
      <p>
        The Workflow API is mounted at <code>{apiBase}</code>.
      </p>
      <ul>
        <li>
          <a href={`${apiBase}/health`}>Health</a>
        </li>
        <li>
          <a href={`${apiBase}/manifest`}>Manifest</a>
        </li>
        <li>
          <a href={`${apiBase}/runs`}>Runs</a>
        </li>
      </ul>
    </main>
  );
}

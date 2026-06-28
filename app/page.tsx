export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>textmap-research</h1>
      <p>
        Research surface for evaluating how LLMs read spatial scenes across
        representations (textmap, datastore, image, structured).
      </p>
      <ul>
        <li>
          <a href="/test-design/dev/repr-eval">repr-eval dev workspace</a>
        </li>
      </ul>
      <p>
        API: <code>/api/experiments/repr-eval/run</code>,{" "}
        <code>/api/experiments/repr-eval/preview</code>,{" "}
        <code>/api/experiments/repr-eval/chat</code>,{" "}
        <code>/api/experiments/repr-eval/selftest</code>
      </p>
    </main>
  );
}

interface PipelineStripProps {
  sourceReady: boolean;
  assetReady: boolean;
  onOpenExports(): void;
}

export function PipelineStrip({ sourceReady, assetReady, onOpenExports }: PipelineStripProps) {
  return (
    <section className="pipeline-strip" aria-label="Asset generation pipeline">
      <div className={`pipeline-stage${sourceReady ? " is-ready" : ""}`}>
        <span className="pipeline-stage__index">1</span>
        <span><strong>Splat</strong><small>{sourceReady ? "Source ready" : "Add a source"}</small></span>
      </div>
      <span className="pipeline-connector" aria-hidden="true" />
      <div className={`pipeline-stage${assetReady ? " is-ready" : ""}`}>
        <span className="pipeline-stage__index">2</span>
        <span><strong>3D asset</strong><small>{assetReady ? "Mesh ready" : "Generate mesh"}</small></span>
      </div>
      <span className="pipeline-connector" aria-hidden="true" />
      <button className="pipeline-exports" type="button" onClick={onOpenExports}>
        <span className="pipeline-stage__index">3</span>
        <span><strong>Export</strong><small>Isaac Sim · MuJoCo · Unreal</small></span>
      </button>
    </section>
  );
}

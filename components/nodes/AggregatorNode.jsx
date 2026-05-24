import { Handle, Position } from 'reactflow';
import { formatUSD } from '../../synth.js';

export default function AggregatorNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };

  return (
    <div
      className={`flow-node aggregator ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
      style={{
        backgroundColor: 'var(--surface-2)',
        borderStyle: 'dashed',
        borderColor: 'var(--border)',
        opacity: 0.85,
      }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="flow-node-name">{node.company}</div>
      <div className="flow-node-meta">
        <span className="chip" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)' }}>AGGREGATOR</span>
        {node.children && <span className="chip">{node.children.length} brands</span>}
        {rev && rev.central > 0 && (
          <>
            <span className={`confidence-dot confidence-${rev.confidence || 'low'}`} />
            <span className="flow-node-rev">{formatUSD(rev.central)}</span>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

import { Handle, Position } from 'reactflow';

export default function PrivateCompanyNode({ data, selected }) {
  const { node, role, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };

  return (
    <div
      className={`flow-node private-company ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.company)}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="flow-node-name">{node.company}</div>
      {node.category && <div className="flow-node-detail" style={{ fontSize: 10, marginTop: 2, color: 'var(--text-muted)' }}>{node.category}</div>}
      <div className="flow-node-meta">
        <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
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

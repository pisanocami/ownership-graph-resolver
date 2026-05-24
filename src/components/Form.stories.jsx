export default {
  title: 'Components/Form',
  tags: ['autodocs'],
};

export const InputField = () => (
  <div>
    <label className="field-label">Company Name</label>
    <input className="input" type="text" placeholder="Enter company name" />
  </div>
);

export const SelectField = () => (
  <div>
    <label className="field-label">Entity Type</label>
    <select className="select">
      <option>Select an option</option>
      <option>Public Company</option>
      <option>Private Company</option>
      <option>Subsidiary</option>
    </select>
  </div>
);

export const InputForm = () => (
  <form className="input-form">
    <div>
      <label className="field-label">Company Name</label>
      <input className="input" type="text" placeholder="e.g., Acme Corp" />
    </div>
    <div>
      <label className="field-label">Country</label>
      <select className="select">
        <option>United States</option>
        <option>United Kingdom</option>
        <option>Germany</option>
      </select>
    </div>
    <button className="btn btn-primary">Investigate</button>
  </form>
);

export const FormField = () => (
  <div style={{ maxWidth: '400px' }}>
    <div style={{ marginBottom: '16px' }}>
      <label className="field-label">Email Address</label>
      <input className="input" type="email" placeholder="you@example.com" />
    </div>
    <div style={{ marginBottom: '16px' }}>
      <label className="field-label">Password</label>
      <input className="input" type="password" placeholder="••••••••" />
    </div>
  </div>
);

export const FormWithErrorState = () => (
  <div style={{ maxWidth: '400px' }}>
    <label className="field-label">Username</label>
    <input className="input" type="text" placeholder="Enter username" />
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: '4px' }}>
      Username must be at least 3 characters
    </div>
  </div>
);

export const ProviderSelector = () => (
  <div>
    <div className="provider-bar">
      <span className="provider-bar-label">Model:</span>
      <select className="select">
        <option>Claude Sonnet</option>
        <option>Claude Opus</option>
      </select>
    </div>
  </div>
);

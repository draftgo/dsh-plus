import React from 'react';
import { CustomSelect } from './custom-select.jsx';

/** Adapter keeps existing controlled form handlers and opaque option values. */
export function Select({ children, onChange, ...props }) {
  const options = [];
  const collect = nodes => React.Children.forEach(nodes, child => {
    if (!React.isValidElement(child)) return;
    if (child.type === 'option') options.push({ value: child.props.value, label: child.props.children, disabled: child.props.disabled });
    else if (child.type === React.Fragment || child.type === 'optgroup') collect(child.props.children);
  });
  collect(children);
  return <CustomSelect {...props} options={options} onChange={value => onChange?.({ target: { value } })} />;
}

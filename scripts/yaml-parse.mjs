import yaml from 'js-yaml';
export const parse = (input) => yaml.load(input);
export const stringify = (input, options = {}) => yaml.dump(input, {
  indent: 2,
  lineWidth: 120,
  noCompatMode: true,
  quotingType: '"',
  forceQuotes: false,
  noRefs: true,
  ...options,
});

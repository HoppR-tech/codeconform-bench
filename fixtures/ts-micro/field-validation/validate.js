// Profile field validation.
//
// `validateProfile(fields)` receives a plain object of user-supplied profile
// fields and returns an array of structured error objects, one per violated
// rule, in the order the rules are listed below. An empty array means the
// profile is valid. The function never throws on ordinary bad input; it
// reports problems as errors.
//
// Rules (checked in this order):
// 1. username — required: a non-empty string of 3-20 characters matching
//    /^[a-z0-9_]+$/ (lowercase letters, digits, underscores). Violations are
//    reported as { field: 'username', code: 'required' | 'format' }.
// 2. email — required when `emailRequired` is true on the fields object;
//    otherwise optional but, when present, must contain exactly one '@' with
//    non-empty local part and domain. Violations:
//    { field: 'email', code: 'required' | 'format' }.
// 3. age — optional; when present it must be an integer between 13 and 120.
//    Violation: { field: 'age', code: 'range' }.
// 4. website — optional; when present and not an empty string it must start
//    with 'https://'. Violation: { field: 'website', code: 'format' }.
export function validateProfile(fields) {
  return []
}

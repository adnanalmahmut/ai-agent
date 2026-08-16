import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui';
import { useId } from 'react';
import { useTranslations } from 'use-intl';

import {
  ORGANIZATION_ROLE_NAMES,
  type OrganizationRoleName,
} from '@/features/authorization/permissions';

/**
 * Picks an organization role.
 *
 * The options come from the role catalogue rather than a literal list, so a
 * role added on the server and mirrored there appears here without this file
 * changing — and so no role name is written in a component.
 *
 * Radix's `Select` reports a plain string, so the value is narrowed once here
 * — the option list is built from the same catalogue, so nothing else can
 * reach the callback.
 *
 * Every role is offered, including `owner`, and that is deliberate. Whether
 * this caller may hand out a given role is the server's decision: Better Auth
 * refuses `YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE`, which the UI
 * surfaces as a translated message. Hiding the option instead would encode a
 * rule in the browser that could drift from the one being enforced.
 */
export function OrganizationRoleSelect({
  value,
  onChange,
  label,
  disabled,
  hideLabel = false,
}: {
  value: OrganizationRoleName;
  onChange: (role: OrganizationRoleName) => void;
  label: string;
  disabled?: boolean;
  /** For a select inside a table row, where the column header is the label. */
  hideLabel?: boolean;
}) {
  const t = useTranslations('Organization');
  const id = useId();

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </Label>

      <Select
        value={value}
        onValueChange={(next) => onChange(next as OrganizationRoleName)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>

        <SelectContent>
          {ORGANIZATION_ROLE_NAMES.map((role) => (
            <SelectItem key={role} value={role}>
              {t(`roles.${role}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

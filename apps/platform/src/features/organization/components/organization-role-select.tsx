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

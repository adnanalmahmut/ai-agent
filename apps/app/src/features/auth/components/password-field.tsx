import { Button } from '@repo/ui';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useState } from 'react';

import { FormField } from './form-field';

export function PasswordField({
  label,
  autoComplete,
  issue,
  hint,
  value,
  onChange,
  disabled,
  required,
  autoFocus,
}: {
  label: string;
  autoComplete: 'current-password' | 'new-password';
  issue?: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const t = useTranslations('Auth');
  const [isVisible, setIsVisible] = useState(false);

  return (
    <FormField
      type={isVisible ? 'text' : 'password'}
      label={label}
      autoComplete={autoComplete}
      issue={issue}
      hint={hint}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      required={required}
      autoFocus={autoFocus}
      trailing={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t(isVisible ? 'password.hide' : 'password.show')}
          aria-pressed={isVisible}
          onClick={() => setIsVisible((current) => !current)}
        >
          {isVisible ? <EyeOff /> : <Eye />}
        </Button>
      }
    />
  );
}

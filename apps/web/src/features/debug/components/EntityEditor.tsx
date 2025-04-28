import { useState, ReactNode, Dispatch, SetStateAction, useEffect, useLayoutEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// Define entity types for the prop
type EntityTypeName = 'Task' | 'User' | 'Project' | 'Comment';

export interface EntityField<T> {
  key: keyof T;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'number' | 'custom';
  required?: boolean;
  renderInput?: (
    value: any, 
    onChange: (value: any) => void, 
    item: T | null
  ) => ReactNode;
}

export interface EntityEditorProps<T> {
  title: string;
  item: T | null;
  isLoading?: boolean;
  entityType: EntityTypeName;
  fields: EntityField<T>[];
  onSave: (item: T) => Promise<void>;
  onDelete?: (item: T) => Promise<void>;
  onCancel: () => void;
}

export function EntityEditor<T extends { id: string }>({
  title,
  item,
  isLoading = false,
  entityType,
  fields,
  onSave,
  onDelete,
  onCancel
}: EntityEditorProps<T>) {
  // Create a state object with all editable fields
  const initialValues = {} as Record<keyof T, any>;
  
  if (item) {
    fields.forEach(field => {
      initialValues[field.key] = item[field.key];
    });
  }
  
  const [values, setValues] = useState<Record<keyof T, any>>(initialValues);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Update values when item changes
  useEffect(() => {
    if (item) {
      const newValues = {} as Record<keyof T, any>;
      fields.forEach(field => {
        newValues[field.key] = item[field.key];
      });
      setValues(newValues);
    }
  }, [item, fields]);
  
  // Add useLayoutEffect to log timing after render based on item prop
  useLayoutEffect(() => {
    if (item?.id) {
      // Construct the label based on the pattern started in the parent
      const timerLabel = `Parent Update Cycle - ${entityType} - ${item.id}`;
      console.timeEnd(timerLabel);
    }
    // We only want this to run when the item *successfully* updates
  }, [item, entityType]);
  
  // Handle field changes
  const handleChange = (key: keyof T, value: any) => {
    setValues(prev => ({
      ...prev,
      [key]: value
    }));
  };
  
  // Handle save
  const handleSave = async () => {
    if (!item) return;
    
    setIsSaving(true);
    try {
      // Create updated item with original values plus changed ones
      const updatedItem = {
        ...item,
        ...values
      };
      
      await onSave(updatedItem);
    } finally {
      setIsSaving(false);
    }
  };
  
  // Handle delete
  const handleDelete = async () => {
    if (!item || !onDelete) return;
    
    setIsDeleting(true);
    try {
      await onDelete(item);
    } finally {
      setIsDeleting(false);
    }
  };
  
  // Check if form is valid
  const isValid = () => {
    return fields.every(field => 
      !field.required || (values[field.key] !== undefined && values[field.key] !== '')
    );
  };
  
  // Show loading state
  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6 flex flex-col items-center justify-center min-h-[200px]">
          <div className="w-full max-w-sm space-y-4">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // Show empty state if no item selected
  if (!item) {
    return (
      <Card>
        <CardContent className="pt-6 flex flex-col items-center justify-center min-h-[200px]">
          <div className="text-muted-foreground">
            No item selected
          </div>
        </CardContent>
      </Card>
    );
  }
  
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Badge>ID: {item.id.substring(0, 8)}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => (
          <div key={field.key as string} className="space-y-2">
            <Label htmlFor={field.key as string}>
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            
            {field.renderInput ? (
              field.renderInput(values[field.key], 
                (value) => handleChange(field.key, value), 
                item)
            ) : field.type === 'textarea' ? (
              <Textarea
                id={field.key as string}
                value={values[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
                rows={3}
              />
            ) : field.type === 'number' ? (
              <Input
                id={field.key as string}
                type="number"
                value={values[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
              />
            ) : (
              <Input
                id={field.key as string}
                type={field.type === 'email' ? 'email' : 'text'}
                value={values[field.key] || ''}
                onChange={(e) => handleChange(field.key, e.target.value)}
              />
            )}
          </div>
        ))}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <div className="space-x-2">
          {onDelete && (
            <Button 
              variant="destructive" 
              onClick={handleDelete}
              disabled={isDeleting || isSaving}
            >
              {isDeleting ? (
                <>
                  Deleting...
                </>
              ) : 'Delete'}
            </Button>
          )}
          <Button 
            onClick={handleSave} 
            disabled={!isValid() || isSaving || isDeleting}
          >
            {isSaving ? (
              <>
                Saving...
              </>
            ) : 'Save Changes'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
} 
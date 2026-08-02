import React, { useState, useEffect, useRef } from 'react';
import TextField from '@mui/material/TextField';
import { Task } from '../../../../types/task';

interface TaskBasicFormProps {
  taskData: Task;
  onChange: (updatedData: Partial<Task>, isValid: boolean) => void;
}

/**
 * 任务基本信息表单组件
 * 用于编辑任务的名称
 */
const TaskBasicForm: React.FC<TaskBasicFormProps> = ({ taskData, onChange }) => {
  // 表单数据状态
  const [name, setName] = useState(taskData.name);
  
  // 表单验证状态
  const [nameError, setNameError] = useState('');
  
  // 初始化标记：onChange 是父组件每渲染重建的 inline 函数，且父组件在 onChange 后会生成新的 taskData 对象，
  // 若每次 effect 都无条件调用 onChange 会形成「setState -> 重渲染 -> effect 再触发」的无限循环。
  // 因此仅在首次挂载时执行一次初始化（回填名称 + 通知父组件验证状态），用户后续输入走 handleNameChange。
  const initializedRef = useRef(false);
  
  // 初始化表单数据（仅首次挂载执行）
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    setName(taskData.name);
    // 初始化时就通知父组件当前的验证状态
    const isValid = !!taskData.name.trim();
    if (!taskData.name.trim()) {
      setNameError('任务名称不能为空');
    } else {
      setNameError('');
    }
    onChange(
      {
        name: taskData.name
      },
      isValid
    );
  }, [taskData, onChange]);
  
  // 处理名称更改
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setName(newName);
    
    // 验证名称
    if (!newName.trim()) {
      setNameError('任务名称不能为空');
    } else {
      setNameError('');
    }
    
    updateParent(newName);
  };
  
  // 更新父组件数据
  const updateParent = (newName: string) => {
    const isValid = !!newName.trim();
    
    onChange(
      {
        name: newName
      },
      isValid
    );
  };
  
  return (
    <TextField
      label="任务名称"
      fullWidth
      required
      value={name}
      onChange={handleNameChange}
      error={!!nameError}
      helperText={nameError || ''}
      variant="outlined"
      margin="dense"
      size="small"
    />
  );
};

export default TaskBasicForm; 

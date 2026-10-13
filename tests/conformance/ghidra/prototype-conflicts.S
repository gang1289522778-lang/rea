// Source-owned x86-32 instruction oracle. These bytes are statically analyzed,
// never executed. No source-level argument or compiler identity is asserted.
.text
.globl _start, rea_stack_x87, rea_cleanup_conflict, rea_cleanup_control
.globl rea_local_control, rea_stack_control, rea_forward_return, rea_overwrite_return
.type _start, @function
_start:
    call rea_stack_x87
    call rea_cleanup_conflict
    call rea_cleanup_control
    call rea_local_control
    call rea_stack_control
    call rea_forward_return
    mov %eax, %ebx
    call rea_forward_clear_xor
    xor %eax, %eax
    call rea_forward_clear_sub
    sub %eax, %eax
    call rea_forward_clear_and
    and $0, %eax
    call rea_forward_clear_test
    test $0, %eax
    call rea_overwrite_return
    call rea_written_slot_control
    call rea_unknown_store_control
    call rea_conditional_pointer_control
    call rea_dynamic_stack_control
    call rea_padding_control
    call rea_shared_cleanup
    call rea_tail_call_control
    call rea_stdcall_missing_cleanup
    call rea_userop_control
    call rea_fastcall_missing_cleanup
    call rea_thiscall_missing_cleanup
    call rea_custom_allocation_control
    call rea_variadic_control
    call rea_variadic_cleanup_conflict
    call rea_long_entry_prefix
    ret
.size _start, .-_start

.type rea_stack_x87, @function
rea_stack_x87:
    fldl 4(%esp)
    fld1
    fmulp
    call rea_conversion_helper
    ret
.size rea_stack_x87, .-rea_stack_x87

.type rea_conversion_helper, @function
rea_conversion_helper:
    sub $8, %esp
    fistpl (%esp)
    pop %eax
    add $4, %esp
    ret
.size rea_conversion_helper, .-rea_conversion_helper

.type rea_cleanup_conflict, @function
rea_cleanup_conflict:
    push %ebp
    mov %esp, %ebp
    mov 8(%ebp), %eax
    add 12(%ebp), %eax
    add 16(%ebp), %eax
    add 20(%ebp), %eax
    pop %ebp
    ret $20
.size rea_cleanup_conflict, .-rea_cleanup_conflict

.type rea_cleanup_control, @function
rea_cleanup_control:
    push %ebp
    mov %esp, %ebp
    mov 8(%ebp), %eax
    add 12(%ebp), %eax
    add 16(%ebp), %eax
    add 20(%ebp), %eax
    pop %ebp
    ret $16
.size rea_cleanup_control, .-rea_cleanup_control

.type rea_local_control, @function
rea_local_control:
    sub $8, %esp
    mov 4(%esp), %eax
    add $8, %esp
    ret
.size rea_local_control, .-rea_local_control

.type rea_stack_control, @function
rea_stack_control:
    sub $16, %esp
    mov 20(%esp), %eax
    add $16, %esp
    ret
.size rea_stack_control, .-rea_stack_control

.type rea_forward_return, @function
rea_forward_return:
    call rea_conversion_helper
    ret
.size rea_forward_return, .-rea_forward_return

.globl rea_forward_clear_xor, rea_forward_clear_sub
.type rea_forward_clear_xor, @function
rea_forward_clear_xor:
    call rea_conversion_helper
    ret
.size rea_forward_clear_xor, .-rea_forward_clear_xor

.type rea_forward_clear_sub, @function
rea_forward_clear_sub:
    call rea_conversion_helper
    ret
.size rea_forward_clear_sub, .-rea_forward_clear_sub

.type rea_overwrite_return, @function
rea_overwrite_return:
    call rea_conversion_helper
    xor %eax, %eax
    ret
.size rea_overwrite_return, .-rea_overwrite_return

.globl rea_written_slot_control, rea_unknown_store_control
.type rea_written_slot_control, @function
rea_written_slot_control:
    movl $7, 4(%esp)
    fldl 4(%esp)
    ret
.size rea_written_slot_control, .-rea_written_slot_control

.type rea_unknown_store_control, @function
rea_unknown_store_control:
    movl $7, (%eax)
    fldl 4(%esp)
    ret
.size rea_unknown_store_control, .-rea_unknown_store_control

.globl rea_conditional_pointer_control, rea_dynamic_stack_control
.type rea_conditional_pointer_control, @function
rea_conditional_pointer_control:
    lea 4(%esp), %edx
    lea 8(%esp), %ecx
    cmovne %edx, %ecx
    fldl (%ecx)
    ret
.size rea_conditional_pointer_control, .-rea_conditional_pointer_control

.type rea_dynamic_stack_control, @function
rea_dynamic_stack_control:
    sub %eax, %esp
    fldl 4(%esp)
    ret
.size rea_dynamic_stack_control, .-rea_dynamic_stack_control

.globl rea_padding_control
.type rea_padding_control, @function
rea_padding_control:
    mov 4(%esp), %eax
    and $255, %eax
    ret $4
.size rea_padding_control, .-rea_padding_control

.globl rea_shared_cleanup, rea_shared_return
.type rea_shared_cleanup, @function
rea_shared_cleanup:
    mov 4(%esp), %eax
    add 8(%esp), %eax
    add 12(%esp), %eax
    add 16(%esp), %eax
    jmp rea_shared_return
.size rea_shared_cleanup, .-rea_shared_cleanup
rea_shared_return:
    ret $20

.globl rea_tail_call_control, rea_tail_target
.type rea_tail_call_control, @function
rea_tail_call_control:
    jmp rea_tail_target
.size rea_tail_call_control, .-rea_tail_call_control
.type rea_tail_target, @function
rea_tail_target:
    ret $20
.size rea_tail_target, .-rea_tail_target

.globl rea_stdcall_missing_cleanup
.type rea_stdcall_missing_cleanup, @function
rea_stdcall_missing_cleanup:
    mov 4(%esp), %eax
    ret
.size rea_stdcall_missing_cleanup, .-rea_stdcall_missing_cleanup

.globl rea_userop_control
.type rea_userop_control, @function
rea_userop_control:
    fxsave 4(%esp)
    mov 4(%esp), %eax
    ret
.size rea_userop_control, .-rea_userop_control

.globl rea_fastcall_missing_cleanup, rea_thiscall_missing_cleanup
.type rea_fastcall_missing_cleanup, @function
rea_fastcall_missing_cleanup:
    mov 4(%esp), %eax
    ret
.size rea_fastcall_missing_cleanup, .-rea_fastcall_missing_cleanup
.type rea_thiscall_missing_cleanup, @function
rea_thiscall_missing_cleanup:
    mov 4(%esp), %eax
    ret
.size rea_thiscall_missing_cleanup, .-rea_thiscall_missing_cleanup

.globl rea_custom_allocation_control, rea_variadic_control
.type rea_custom_allocation_control, @function
rea_custom_allocation_control:
    mov 4(%esp), %eax
    and $255, %eax
    ret $4
.size rea_custom_allocation_control, .-rea_custom_allocation_control
.type rea_variadic_control, @function
rea_variadic_control:
    mov 8(%esp), %eax
    ret
.size rea_variadic_control, .-rea_variadic_control

.globl rea_cdecl_cleanup_conflict
.type rea_cdecl_cleanup_conflict, @function
rea_cdecl_cleanup_conflict:
    mov 4(%esp), %eax
    ret $4
.size rea_cdecl_cleanup_conflict, .-rea_cdecl_cleanup_conflict

.globl rea_named_undefined_return, rea_undefined_pointer_return
.type rea_named_undefined_return, @function
rea_named_undefined_return:
    call rea_conversion_helper
    ret
.size rea_named_undefined_return, .-rea_named_undefined_return
.type rea_undefined_pointer_return, @function
rea_undefined_pointer_return:
    call rea_conversion_helper
    ret
.size rea_undefined_pointer_return, .-rea_undefined_pointer_return

.globl rea_many_forwarding
.type rea_many_forwarding, @function
rea_many_forwarding:
.rept 130
    test %eax, %eax
    jz 1f
    call rea_conversion_helper
    ret
1:
.endr
    ret
.size rea_many_forwarding, .-rea_many_forwarding

.section .note.GNU-stack,"",@progbits


.globl rea_forward_clear_and, rea_forward_clear_test
.type rea_forward_clear_and, @function
rea_forward_clear_and:
    call rea_conversion_helper
    ret
.size rea_forward_clear_and, .-rea_forward_clear_and
.type rea_forward_clear_test, @function
rea_forward_clear_test:
    call rea_conversion_helper
    ret
.size rea_forward_clear_test, .-rea_forward_clear_test

.globl rea_variadic_cleanup_conflict
.type rea_variadic_cleanup_conflict, @function
rea_variadic_cleanup_conflict:
    mov 8(%esp), %eax
    ret $4
.size rea_variadic_cleanup_conflict, .-rea_variadic_cleanup_conflict

.globl rea_long_entry_prefix
.type rea_long_entry_prefix, @function
rea_long_entry_prefix:
    .rept 300
    mov 8(%esp), %eax
    .endr
    ret
.size rea_long_entry_prefix, .-rea_long_entry_prefix

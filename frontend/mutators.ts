import { WriteTransaction } from "replicache";
import { getTodo, putTodo, Todo, todoKey } from "./todo";

export type M = typeof mutators;

export const mutators = {
  putTodo,

  updateTodo: async (
    tx: WriteTransaction,
    {
      id,
      changes,
    }: {
      id: string;
      changes: Omit<Partial<Todo>, "id">;
    }
  ): Promise<void> => {
    const todo = await getTodo(tx, id);
    if (todo === undefined) {
      console.info(`Todo ${id} not found`);
      return;
    }
    const changed = { ...todo, ...changes };
    await putTodo(tx, changed);
  },

  deleteTodos: async (tx: WriteTransaction, ids: string[]): Promise<void> => {
    for (const id of ids) {
      await tx.del(todoKey(id));
    }
  },

  completeTodos: async (
    tx: WriteTransaction,
    { completed, ids }: { completed: boolean; ids: string[] }
  ): Promise<void> => {
    // Note: we could also use tx.scan() to get all the todos and
    // mark uncompleted ones completed. However, that has slightly different
    // semantics. By passing in the ids, we are only updating the ones that
    // the user saw when they pressed the button. Concurrently created todos
    // won't be affected. I think this is less surprising in this case, but
    // you can choose the semantics you prefer.
    for (const id of ids) {
      const todo = await getTodo(tx, id);
      if (!todo) {
        console.warn("Todo not found:", id);
        continue;
      }
      todo.completed = completed;
      await tx.put(todoKey(id), todo);
    }
  },
};
